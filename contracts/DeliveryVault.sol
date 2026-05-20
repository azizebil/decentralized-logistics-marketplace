// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./StakingPool.sol";

/**
 * @title DeliveryVault
 * @notice Per-delivery escrow. Holds the buyer's payment, the hashes of the
 *         pickup and dropoff codes, the pickup and dropoff deadlines, and
 *         coordinates with StakingPool for reservation and slashing.
 *
 * Phase-2 enforcement (from architecture doc, Section 1.1.2):
 *   - funds must be locked before pickup (cannot enter PickedUp unless buyer has funded)
 *   - preimage binding: stored hash commits to keccak256(code || deliveryId || nonce),
 *     so a code revealed for one delivery cannot be replayed on another
 *   - once finalized = true no further payout/refund/slash can be triggered
 *   - courier payout address is locked at acceptance time
 *   - no cancellation between PickedUp and dropoffDeadline
 *
 * Attacks addressed (Section 4):
 *   - Reentrancy on payout/refund: checks-effects-interactions + nonReentrant +
 *     `call` with explicit gas-cap free pattern (no transfer)
 *   - Mailbox spoofing: optional dispute window before finalization
 */
contract DeliveryVault {

    // ----------------------------------------------------------------------
    // State machine
    // ----------------------------------------------------------------------

    enum State {
        Funded,     // buyer has deposited; awaiting courier pickup
        PickedUp,   // courier revealed pickup code
        Delivered,  // mailbox confirmed dropoff (dispute window may apply)
        Refunded,   // buyer reclaimed funds (timeout or pre-pickup cancellation)
        Failed      // delivery slashed; pool paid out
    }

    // ----------------------------------------------------------------------
    // Immutable / once-set parameters
    // ----------------------------------------------------------------------

    address public immutable registry;          // MarketplaceRegistry that spawned us
    bytes32 public immutable deliveryId;        // unique id from registry

    address public immutable seller;
    address public immutable buyer;
    address public immutable courier;
    address public immutable courierPayout;     // locked at acceptance time
    StakingPool public immutable pool;

    uint256 public immutable declaredValue;     // package value, used for slash
    uint256 public immutable courierFee;        // amount paid on success

    bytes32 public immutable pickupHash;        // keccak256(pickupCode || deliveryId || nonceP)
    bytes32 public immutable dropoffHash;       // keccak256(dropoffCode || deliveryId || nonceD)

    uint256 public immutable pickupDeadline;
    uint256 public immutable dropoffDeadline;

    address public immutable mailbox;           // buyer's mailbox signing address
    uint256 public immutable disputeWindow;     // seconds; 0 = disabled

    // ----------------------------------------------------------------------
    // Mutable state
    // ----------------------------------------------------------------------

    State   public state;
    bool    public finalized;       // payout/refund/slash already executed
    bool    public funded;          // buyer has deposited the courier fee
    uint256 public deliveredAt;     // start of dispute window
    bool    public disputed;        // buyer raised dispute

    // ----------------------------------------------------------------------
    // Events
    // ----------------------------------------------------------------------

    event Funded(address indexed buyer, uint256 amount);
    event PickedUp(address indexed courier, uint256 at);
    event Delivered(address indexed mailbox, uint256 at);
    event Disputed(address indexed by, uint256 at);
    event DisputeResolved(bool inFavorOfCourier);
    event Payout(address indexed to, uint256 amount);
    event Refund(address indexed to, uint256 amount);
    event Slashed(uint256 declared, uint256 recovered);

    // ----------------------------------------------------------------------
    // Reentrancy guard
    // ----------------------------------------------------------------------

    uint256 private _lock = 1;
    modifier nonReentrant() {
        require(_lock == 1, "Vault: reentrancy");
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier notFinalized() {
        require(!finalized, "Vault: finalized");
        _;
    }

    // ----------------------------------------------------------------------
    // Constructor parameters as a struct (avoids stack-too-deep)
    // ----------------------------------------------------------------------

    struct Params {
        bytes32 deliveryId;
        address seller;
        address buyer;
        address courier;
        address courierPayout;
        address pool;
        uint256 declaredValue;
        uint256 courierFee;
        bytes32 pickupHash;
        bytes32 dropoffHash;
        uint256 pickupDeadline;
        uint256 dropoffDeadline;
        address mailbox;
        uint256 disputeWindow;
    }

    constructor(Params memory p) {
        require(p.deliveryId      != bytes32(0), "Vault: zero id");
        require(p.seller          != address(0), "Vault: zero seller");
        require(p.buyer           != address(0), "Vault: zero buyer");
        require(p.courier         != address(0), "Vault: zero courier");
        require(p.courierPayout   != address(0), "Vault: zero payout");
        require(p.pool            != address(0), "Vault: zero pool");
        require(p.mailbox         != address(0), "Vault: zero mailbox");
        require(p.declaredValue   > 0, "Vault: zero value");
        require(p.courierFee      > 0, "Vault: zero fee");
        require(p.pickupHash      != bytes32(0), "Vault: zero pickup hash");
        require(p.dropoffHash     != bytes32(0), "Vault: zero dropoff hash");
        require(p.pickupDeadline  > block.timestamp, "Vault: pickup in past");
        require(p.dropoffDeadline > p.pickupDeadline, "Vault: bad dropoff");

        registry = msg.sender;
        deliveryId      = p.deliveryId;
        seller          = p.seller;
        buyer           = p.buyer;
        courier         = p.courier;
        courierPayout   = p.courierPayout;
        pool            = StakingPool(payable(p.pool));
        declaredValue   = p.declaredValue;
        courierFee      = p.courierFee;
        pickupHash      = p.pickupHash;
        dropoffHash     = p.dropoffHash;
        pickupDeadline  = p.pickupDeadline;
        dropoffDeadline = p.dropoffDeadline;
        mailbox         = p.mailbox;
        disputeWindow   = p.disputeWindow;

        // NOTE: the registry calls `initialize()` immediately after deployment
        // and registration so the pool reservation happens atomically.
        state = State.Funded;  // logical state; not yet funded with ETH
    }

    /// @notice One-shot reservation hook called by the registry exactly once
    ///         after `registerByFactory` has authorized this vault on the pool.
    bool private _initialized;
    function initialize() external {
        require(msg.sender == registry, "Vault: not registry");
        require(!_initialized, "Vault: already initialized");
        _initialized = true;
        pool.reserve(courier, declaredValue);
    }

    // ----------------------------------------------------------------------
    // Funding
    // ----------------------------------------------------------------------

    /// @notice Buyer locks the courier fee. Funding is required before pickup.
    function fund() external payable {
        require(msg.sender == buyer, "Vault: not buyer");
        require(!funded, "Vault: already funded");
        require(msg.value == courierFee, "Vault: wrong amount");
        funded = true;
        emit Funded(buyer, msg.value);
    }

    // ----------------------------------------------------------------------
    // Courier reveals pickup code
    // ----------------------------------------------------------------------

    function pickup(bytes calldata code, bytes32 nonce) external notFinalized {
        require(msg.sender == courier, "Vault: not courier");
        require(state == State.Funded, "Vault: bad state");
        require(funded, "Vault: buyer not funded");
        require(block.timestamp <= pickupDeadline, "Vault: pickup deadline");
        require(
            keccak256(abi.encodePacked(code, deliveryId, nonce)) == pickupHash,
            "Vault: bad pickup preimage"
        );
        state = State.PickedUp;
        emit PickedUp(msg.sender, block.timestamp);
    }

    // ----------------------------------------------------------------------
    // Mailbox confirms dropoff
    // ----------------------------------------------------------------------

    function confirmDelivery(bytes calldata code, bytes32 nonce) external notFinalized {
        require(msg.sender == mailbox, "Vault: not mailbox");
        require(state == State.PickedUp, "Vault: bad state");
        require(block.timestamp <= dropoffDeadline, "Vault: dropoff deadline");
        require(
            keccak256(abi.encodePacked(code, deliveryId, nonce)) == dropoffHash,
            "Vault: bad dropoff preimage"
        );
        state = State.Delivered;
        deliveredAt = block.timestamp;
        emit Delivered(msg.sender, block.timestamp);

        // If no dispute window is configured, finalize immediately.
        if (disputeWindow == 0) {
            _payout();
        }
    }

    // ----------------------------------------------------------------------
    // Buyer dispute (within window)
    // ----------------------------------------------------------------------

    function raiseDispute() external notFinalized {
        require(msg.sender == buyer, "Vault: not buyer");
        require(state == State.Delivered, "Vault: bad state");
        require(disputeWindow > 0, "Vault: no window");
        require(block.timestamp <= deliveredAt + disputeWindow, "Vault: window closed");
        require(!disputed, "Vault: already disputed");
        disputed = true;
        emit Disputed(msg.sender, block.timestamp);
    }

    /// @notice Pool operator (or seller, as appeals body) resolves a dispute.
    ///         Off-chain arbitration; the keeper of this call is StakingPool.operator
    ///         since the pool has skin in the game.
    function resolveDispute(bool inFavorOfCourier) external notFinalized nonReentrant {
        require(disputed, "Vault: not disputed");
        require(msg.sender == pool.operator(), "Vault: not arbiter");
        emit DisputeResolved(inFavorOfCourier);
        if (inFavorOfCourier) {
            _payout();
        } else {
            _slashAndRefund();
        }
    }

    /// @notice Anyone can finalize after the dispute window passes without a dispute.
    function finalizeDelivered() external notFinalized nonReentrant {
        require(state == State.Delivered, "Vault: bad state");
        require(disputeWindow > 0, "Vault: no window");
        require(block.timestamp > deliveredAt + disputeWindow, "Vault: window open");
        require(!disputed, "Vault: disputed");
        _payout();
    }

    // ----------------------------------------------------------------------
    // Timeouts
    // ----------------------------------------------------------------------

    /// @notice Buyer refund if courier never picked up before pickupDeadline.
    function refundOnPickupTimeout() external notFinalized nonReentrant {
        require(state == State.Funded, "Vault: bad state");
        require(block.timestamp > pickupDeadline, "Vault: not yet");
        _refund();
    }

    /// @notice After dropoffDeadline expires while still PickedUp, slash courier.
    ///         (No cancellation allowed between PickedUp and dropoffDeadline.)
    function slashOnDropoffTimeout() external notFinalized nonReentrant {
        require(state == State.PickedUp, "Vault: bad state");
        require(block.timestamp > dropoffDeadline, "Vault: not yet");
        _slashAndRefund();
    }

    /// @notice Seller may cancel an open delivery only before any pickup.
    function cancelByBuyerPrePickup() external notFinalized nonReentrant {
        require(msg.sender == buyer, "Vault: not buyer");
        require(state == State.Funded, "Vault: bad state");
        // Allowed any time before pickup, even before pickupDeadline.
        _refund();
    }

    // ----------------------------------------------------------------------
    // Internal: payout / refund / slash (checks-effects-interactions)
    // ----------------------------------------------------------------------

    function _payout() internal {
        // CHECKS handled by callers via notFinalized + state guards.
        // EFFECTS first:
        finalized = true;
        state     = State.Delivered;
        uint256 amount = address(this).balance;  // funded courierFee

        // Tell pool the reservation is over (releases capacity).
        pool.release(courier, declaredValue);

        // INTERACTION last.
        (bool ok, ) = payable(courierPayout).call{value: amount}("");
        require(ok, "Vault: payout failed");
        emit Payout(courierPayout, amount);
    }

    function _refund() internal {
        finalized = true;
        state     = State.Refunded;
        uint256 amount = address(this).balance;

        pool.release(courier, declaredValue);

        if (amount > 0) {
            (bool ok, ) = payable(buyer).call{value: amount}("");
            require(ok, "Vault: refund failed");
            emit Refund(buyer, amount);
        }
    }

    function _slashAndRefund() internal {
        finalized = true;
        state     = State.Failed;
        uint256 buyerOwed = address(this).balance;

        // Pull slashed amount equal to declared value.
        uint256 recovered = pool.slash(courier, declaredValue);
        emit Slashed(declaredValue, recovered);

        // The buyer gets: (a) their original deposit refunded
        //                (b) recovered slash, up to declared value (compensation)
        uint256 totalToBuyer = buyerOwed + recovered;
        if (totalToBuyer > 0) {
            (bool ok, ) = payable(buyer).call{value: totalToBuyer}("");
            require(ok, "Vault: refund failed");
            emit Refund(buyer, totalToBuyer);
        }
    }

    // ----------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------

    function snapshot() external view returns (
        State s, bool isFunded, bool isFinalized, bool isDisputed, uint256 balance
    ) {
        return (state, funded, finalized, disputed, address(this).balance);
    }

    receive() external payable {
        // Only the pool may send ETH directly to the vault (the slash payout
        // flows through here, then is forwarded to the buyer in _slashAndRefund).
        require(msg.sender == address(pool), "Vault: use fund");
    }
}
