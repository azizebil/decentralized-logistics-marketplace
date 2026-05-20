// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./DeliveryVault.sol";
import "./StakingPool.sol";

/**
 * @title MarketplaceRegistry
 * @notice Holds open delivery requests, accepts courier bids, lets the seller
 *         (or seller's session-key agent) accept a winning bid, and spawns a
 *         DeliveryVault for each accepted delivery.
 *
 * Phase-2 enforcement (Section 1.1.1):
 *   - unique delivery id derived from seller address + random
 *   - only seller can modify/cancel while Open
 *   - bids only while Open and before bidDeadline
 *   - courier must belong to the referenced pool, with enough free capacity
 *   - pickup/dropoff hashes locked permanently once published
 *   - strict state transitions: Open -> Assigned -> Held -> Finalized
 *   - exactly one accepted bid per request; exactly one vault per delivery
 *
 * Agent safety (Section 4, "Malicious or buggy LLM"):
 *   - sellers can register a session-key agent with per-delivery limits
 *     (max price, min deadline buffer). acceptBidByAgent enforces them
 *     so a hallucinating LLM cannot finalize an out-of-policy bid.
 *   - sellers may also require a co-signature from their master key above
 *     a value threshold.
 */
contract MarketplaceRegistry {

    // ----------------------------------------------------------------------
    // Types
    // ----------------------------------------------------------------------

    enum Stage { None, Open, Assigned, Held, Finalized, Cancelled }

    struct Request {
        address seller;
        uint256 declaredValue;     // package value, used for staking cap
        uint256 maxPrice;          // seller's budget for the courier fee
        uint256 maxDeadline;       // unix time the buyer needs delivery by
        uint256 bidDeadline;       // unix time bids close
        address buyer;
        address mailbox;
        StakingPool pool;          // accepted pool for this request
        bytes32 pickupHash;
        bytes32 dropoffHash;
        bool    preferTrusted;     // metadata for agent
        uint256 disputeWindow;     // forwarded to the vault
        Stage   stage;
        uint256 acceptedBidIndex;  // valid only after Assigned
        address vault;             // spawned vault address
        uint256 createdAt;
    }

    struct Bid {
        address courier;
        address payout;            // payout address, locked when accepted
        uint256 price;             // ETH the courier wants
        uint256 promisedTime;      // unix time the courier promises to deliver by
        uint256 reputationE4;      // 0..10000, courier-claimed; client-side authoritative
        uint64  submittedAt;
        bool    withdrawn;
    }

    /// @notice Per-seller session-key policy (Section 4 mitigation).
    struct AgentPolicy {
        address agent;             // session key
        uint256 maxPrice;          // hard ceiling
        uint256 minDeadlineBuffer; // dropoff promise must beat seller's deadline by this much
        uint256 coSignThreshold;   // declared value above which seller co-sign is required
        bool    enabled;
    }

    // ----------------------------------------------------------------------
    // Storage
    // ----------------------------------------------------------------------

    mapping(bytes32 => Request) public requests;
    mapping(bytes32 => Bid[])   private bids;
    mapping(address => AgentPolicy) public agentPolicies;
    mapping(address => uint256) private sellerNonce;

    // ----------------------------------------------------------------------
    // Events
    // ----------------------------------------------------------------------

    event RequestOpened(
        bytes32 indexed deliveryId,
        address indexed seller,
        address pool,
        uint256 declaredValue,
        uint256 maxPrice,
        uint256 bidDeadline
    );
    event HashesPublished(bytes32 indexed deliveryId, bytes32 pickupHash, bytes32 dropoffHash);
    event BidPlaced(bytes32 indexed deliveryId, uint256 index, address indexed courier, uint256 price, uint256 promisedTime);
    event BidWithdrawn(bytes32 indexed deliveryId, uint256 index);
    event BidAccepted(bytes32 indexed deliveryId, uint256 index, address courier, address vault);
    event RequestCancelled(bytes32 indexed deliveryId);
    event AgentPolicySet(address indexed seller, address indexed agent, uint256 maxPrice);

    // ----------------------------------------------------------------------
    // Modifiers
    // ----------------------------------------------------------------------

    modifier onlySeller(bytes32 id) {
        require(requests[id].seller == msg.sender, "Registry: not seller");
        _;
    }

    modifier inStage(bytes32 id, Stage s) {
        require(requests[id].stage == s, "Registry: bad stage");
        _;
    }

    // ----------------------------------------------------------------------
    // Seller: agent policy
    // ----------------------------------------------------------------------

    function setAgentPolicy(
        address agent,
        uint256 maxPrice,
        uint256 minDeadlineBuffer,
        uint256 coSignThreshold
    ) external {
        agentPolicies[msg.sender] = AgentPolicy({
            agent: agent,
            maxPrice: maxPrice,
            minDeadlineBuffer: minDeadlineBuffer,
            coSignThreshold: coSignThreshold,
            enabled: agent != address(0)
        });
        emit AgentPolicySet(msg.sender, agent, maxPrice);
    }

    // ----------------------------------------------------------------------
    // Seller: open a request
    // ----------------------------------------------------------------------

    /**
     * @notice Open a new delivery request. The unique deliveryId is derived from
     *         seller + an internal nonce + a user-supplied salt (any random number).
     */
    function openRequest(
        uint256 declaredValue,
        uint256 maxPrice,
        uint256 maxDeadline,
        uint256 bidDeadline,
        address buyer,
        address mailbox,
        StakingPool pool,
        bool    preferTrusted,
        uint256 disputeWindow,
        uint256 salt
    ) external returns (bytes32 deliveryId) {
        require(declaredValue > 0, "Registry: zero value");
        require(maxPrice > 0, "Registry: zero price");
        require(maxDeadline  > block.timestamp,  "Registry: maxDeadline past");
        require(bidDeadline  > block.timestamp,  "Registry: bidDeadline past");
        require(bidDeadline  < maxDeadline,      "Registry: bid > delivery");
        require(buyer        != address(0),      "Registry: zero buyer");
        require(mailbox      != address(0),      "Registry: zero mailbox");
        require(address(pool) != address(0),     "Registry: zero pool");

        uint256 n = ++sellerNonce[msg.sender];
        deliveryId = keccak256(abi.encodePacked(msg.sender, n, salt, block.chainid));
        require(requests[deliveryId].stage == Stage.None, "Registry: id taken");

        Request storage r = requests[deliveryId];
        r.seller         = msg.sender;
        r.declaredValue  = declaredValue;
        r.maxPrice       = maxPrice;
        r.maxDeadline    = maxDeadline;
        r.bidDeadline    = bidDeadline;
        r.buyer          = buyer;
        r.mailbox        = mailbox;
        r.pool           = pool;
        r.preferTrusted  = preferTrusted;
        r.disputeWindow  = disputeWindow;
        r.stage          = Stage.Open;
        r.createdAt      = block.timestamp;

        emit RequestOpened(deliveryId, msg.sender, address(pool), declaredValue, maxPrice, bidDeadline);
    }

    /// @notice Lock pickup/dropoff hashes. Permanent: can only be set once.
    function publishHashes(bytes32 id, bytes32 pickupHash, bytes32 dropoffHash)
        external
        onlySeller(id)
        inStage(id, Stage.Open)
    {
        Request storage r = requests[id];
        require(r.pickupHash == bytes32(0) && r.dropoffHash == bytes32(0), "Registry: hashes locked");
        require(pickupHash != bytes32(0) && dropoffHash != bytes32(0), "Registry: zero hash");
        r.pickupHash  = pickupHash;
        r.dropoffHash = dropoffHash;
        emit HashesPublished(id, pickupHash, dropoffHash);
    }

    function cancelRequest(bytes32 id) external onlySeller(id) inStage(id, Stage.Open) {
        requests[id].stage = Stage.Cancelled;
        emit RequestCancelled(id);
    }

    // ----------------------------------------------------------------------
    // Couriers: place / withdraw bids
    // ----------------------------------------------------------------------

    function placeBid(
        bytes32 id,
        address payout,
        uint256 price,
        uint256 promisedTime,
        uint256 reputationE4
    ) external inStage(id, Stage.Open) returns (uint256 index) {
        Request storage r = requests[id];
        require(block.timestamp <= r.bidDeadline, "Registry: bidding closed");
        require(price <= r.maxPrice, "Registry: price too high");
        require(promisedTime <= r.maxDeadline, "Registry: too slow");
        require(promisedTime > block.timestamp, "Registry: bad promised time");
        require(payout != address(0), "Registry: zero payout");
        require(reputationE4 <= 10000, "Registry: bad reputation");

        // Courier must be a member of the referenced pool with enough free capacity.
        require(r.pool.freeCapacityFor(msg.sender) >= r.declaredValue, "Registry: pool cap");

        index = bids[id].length;
        bids[id].push(Bid({
            courier: msg.sender,
            payout: payout,
            price: price,
            promisedTime: promisedTime,
            reputationE4: reputationE4,
            submittedAt: uint64(block.timestamp),
            withdrawn: false
        }));
        emit BidPlaced(id, index, msg.sender, price, promisedTime);
    }

    function withdrawBid(bytes32 id, uint256 index) external inStage(id, Stage.Open) {
        Bid storage b = bids[id][index];
        require(b.courier == msg.sender, "Registry: not bidder");
        require(!b.withdrawn, "Registry: already withdrawn");
        b.withdrawn = true;
        emit BidWithdrawn(id, index);
    }

    function getBids(bytes32 id) external view returns (Bid[] memory) {
        return bids[id];
    }

    function bidCount(bytes32 id) external view returns (uint256) {
        return bids[id].length;
    }

    // ----------------------------------------------------------------------
    // Seller or agent: accept a winning bid
    // ----------------------------------------------------------------------

    /// @notice Seller directly accepts a bid.
    function acceptBid(bytes32 id, uint256 index)
        external
        onlySeller(id)
        inStage(id, Stage.Open)
        returns (address vault)
    {
        return _accept(id, index);
    }

    /**
     * @notice Agent (session key) accepts a bid on behalf of the seller,
     *         subject to the seller's pre-set AgentPolicy. Off-policy bids revert.
     *         If declaredValue exceeds the seller's coSignThreshold the agent
     *         alone cannot finalize: the seller must also call acceptBid.
     */
    function acceptBidByAgent(bytes32 id, uint256 index)
        external
        inStage(id, Stage.Open)
        returns (address vault)
    {
        Request storage r = requests[id];
        AgentPolicy memory pol = agentPolicies[r.seller];
        require(pol.enabled && pol.agent == msg.sender, "Registry: not agent");

        Bid storage b = bids[id][index];
        require(b.price <= pol.maxPrice, "Registry: agent price ceiling");
        require(b.promisedTime + pol.minDeadlineBuffer <= r.maxDeadline,
                "Registry: agent deadline buffer");

        // Co-sign requirement: above threshold, the agent cannot finalize.
        require(
            pol.coSignThreshold == 0 || r.declaredValue <= pol.coSignThreshold,
            "Registry: co-sign required"
        );

        return _accept(id, index);
    }

    function _accept(bytes32 id, uint256 index) internal returns (address vault) {
        Request storage r = requests[id];
        require(block.timestamp <= r.bidDeadline, "Registry: bidding closed");
        require(r.pickupHash != bytes32(0) && r.dropoffHash != bytes32(0), "Registry: hashes missing");

        Bid storage b = bids[id][index];
        require(!b.withdrawn, "Registry: bid withdrawn");

        // Re-verify capacity at acceptance time (defends against stake drain
        // between bid placement and acceptance).
        require(r.pool.freeCapacityFor(b.courier) >= r.declaredValue, "Registry: pool cap");

        // Spawn vault.
        DeliveryVault.Params memory p = DeliveryVault.Params({
            deliveryId: id,
            seller: r.seller,
            buyer: r.buyer,
            courier: b.courier,
            courierPayout: b.payout,
            pool: address(r.pool),
            declaredValue: r.declaredValue,
            courierFee: b.price,
            pickupHash: r.pickupHash,
            dropoffHash: r.dropoffHash,
            pickupDeadline: b.promisedTime - 1,            // pickup must happen before promised delivery
            dropoffDeadline: b.promisedTime,
            mailbox: r.mailbox,
            disputeWindow: r.disputeWindow
        });

        DeliveryVault dv = new DeliveryVault(p);
        vault = address(dv);

        // Authorize the vault on the pool, then call its one-shot init
        // which reserves capacity atomically. Requires the pool's operator
        // to have set this registry as factory beforehand.
        r.pool.registerByFactory(vault);
        dv.initialize();

        r.stage            = Stage.Assigned;
        r.acceptedBidIndex = index;
        r.vault            = vault;

        emit BidAccepted(id, index, b.courier, vault);
    }

    // ----------------------------------------------------------------------
    // Vault callback: mark Held / Finalized for indexing
    // ----------------------------------------------------------------------

    /// @notice Called by the spawned vault as state moves forward. Optional.
    function markHeld(bytes32 id) external {
        Request storage r = requests[id];
        require(msg.sender == r.vault, "Registry: not our vault");
        require(r.stage == Stage.Assigned, "Registry: bad stage");
        r.stage = Stage.Held;
    }

    function markFinalized(bytes32 id) external {
        Request storage r = requests[id];
        require(msg.sender == r.vault, "Registry: not our vault");
        require(r.stage == Stage.Held || r.stage == Stage.Assigned, "Registry: bad stage");
        r.stage = Stage.Finalized;
    }

    // ----------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------

    function getRequest(bytes32 id) external view returns (Request memory) {
        return requests[id];
    }
}
