// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title StakingPool
 * @notice Shared collateral fund for couriers. Members pool ETH and back each
 *         other's deliveries; if a member fails a delivery, their personal
 *         contribution is slashed first; any shortfall is taken pro-rata from
 *         the remaining members' balances.
 *
 * Phase-2 invariants (from architecture doc, Section 1.1.3):
 *   - activeValue <= totalStake at all times
 *   - per-member reserved value <= memberCap(contribution)
 *   - withdrawal request -> wait `withdrawalDelay` -> finalize withdraw
 *     (must still satisfy capacity after the request)
 *   - only registered DeliveryVault instances may call slash() / release()
 *
 * Slashing policy:
 *   - slash courier's own balance first
 *   - if insufficient, draw remainder proportionally from other members
 */
contract StakingPool {

    // ----------------------------------------------------------------------
    // Storage
    // ----------------------------------------------------------------------

    address public immutable operator;            // pool multisig
    uint256 public immutable withdrawalDelay;     // seconds
    uint256 public immutable memberCapBps;        // e.g. 5000 = 50% of stake

    // The MarketplaceRegistry authorized to spawn vaults. When set, that
    // contract may register a newly-deployed vault in one atomic call
    // (`registerByFactory`). This lets `acceptBid` -> `new DeliveryVault(...)`
    // succeed without a manual operator round-trip per delivery.
    address public factory;

    uint256 public totalStake;                    // sum of member contributions
    uint256 public activeValue;                   // sum of currently-reserved delivery values

    struct Member {
        bool    isMember;
        uint256 contribution;     // ETH currently locked as stake
        uint256 reserved;         // sum of declared values this member is backing
        uint256 withdrawReqAt;    // unix time of withdraw request; 0 = none
        uint256 withdrawReqAmt;   // amount requested
    }

    mapping(address => Member) public members;
    address[] private memberList;                 // for pro-rata accounting

    // DeliveryVaults authorized to reserve/release/slash on this pool
    mapping(address => bool) public registeredVaults;

    // ----------------------------------------------------------------------
    // Events
    // ----------------------------------------------------------------------

    event MemberAdmitted(address indexed member);
    event ContributionAdded(address indexed member, uint256 amount, uint256 newContribution);
    event WithdrawRequested(address indexed member, uint256 amount, uint256 readyAt);
    event WithdrawFinalized(address indexed member, uint256 amount);
    event VaultRegistered(address indexed vault);
    event Reserved(address indexed vault, address indexed courier, uint256 value);
    event Released(address indexed vault, address indexed courier, uint256 value);
    event Slashed(
        address indexed vault,
        address indexed courier,
        uint256 totalSlashed,
        uint256 fromCourier,
        uint256 fromPool
    );

    // ----------------------------------------------------------------------
    // Modifiers
    // ----------------------------------------------------------------------

    modifier onlyOperator() {
        require(msg.sender == operator, "StakingPool: not operator");
        _;
    }

    modifier onlyRegisteredVault() {
        require(registeredVaults[msg.sender], "StakingPool: unregistered vault");
        _;
    }

    // ----------------------------------------------------------------------
    // Reentrancy guard (minimal, no external dep)
    // ----------------------------------------------------------------------

    uint256 private _lock = 1;
    modifier nonReentrant() {
        require(_lock == 1, "StakingPool: reentrancy");
        _lock = 2;
        _;
        _lock = 1;
    }

    // ----------------------------------------------------------------------
    // Constructor
    // ----------------------------------------------------------------------

    /**
     * @param _operator       pool admin multisig (admits members, registers vaults)
     * @param _withdrawalDelay seconds between request and finalize
     * @param _memberCapBps    basis points; per-member reservation cap as % of own stake.
     *                         e.g. 20000 (200%) lets a courier carry up to 2x their
     *                         personal contribution by leveraging the pool's combined stake.
     */
    constructor(address _operator, uint256 _withdrawalDelay, uint256 _memberCapBps) {
        require(_operator != address(0), "StakingPool: zero operator");
        require(_memberCapBps > 0, "StakingPool: zero cap");
        operator = _operator;
        withdrawalDelay = _withdrawalDelay;
        memberCapBps = _memberCapBps;
    }

    // ----------------------------------------------------------------------
    // Operator: membership and vault registry
    // ----------------------------------------------------------------------

    function admitMember(address member) external onlyOperator {
        require(member != address(0), "StakingPool: zero member");
        require(!members[member].isMember, "StakingPool: already member");
        members[member].isMember = true;
        memberList.push(member);
        emit MemberAdmitted(member);
    }

    function registerVault(address vault) external onlyOperator {
        require(vault != address(0), "StakingPool: zero vault");
        require(!registeredVaults[vault], "StakingPool: vault already registered");
        registeredVaults[vault] = true;
        emit VaultRegistered(vault);
    }

    /// @notice Set the trusted factory (MarketplaceRegistry).
    ///         A pool may have at most one factory at a time.
    function setFactory(address newFactory) external onlyOperator {
        factory = newFactory;
    }

    /// @notice Called by the factory in the same transaction that deploys a
    ///         new vault. Atomically registers the vault so it may call
    ///         reserve/release/slash. Operator approval is implicit in the
    ///         one-time setFactory grant.
    function registerByFactory(address vault) external {
        require(msg.sender == factory && factory != address(0), "StakingPool: not factory");
        require(vault != address(0), "StakingPool: zero vault");
        require(!registeredVaults[vault], "StakingPool: vault already registered");
        registeredVaults[vault] = true;
        emit VaultRegistered(vault);
    }

    // ----------------------------------------------------------------------
    // Members: deposits and withdrawals
    // ----------------------------------------------------------------------

    function depositStake() external payable {
        require(members[msg.sender].isMember, "StakingPool: not a member");
        require(msg.value > 0, "StakingPool: zero deposit");
        members[msg.sender].contribution += msg.value;
        totalStake += msg.value;
        emit ContributionAdded(msg.sender, msg.value, members[msg.sender].contribution);
    }

    /**
     * @notice Request withdrawal of `amount` from your own contribution.
     *         The request is accepted only if, after the requested amount is
     *         excluded, `activeValue <= totalStake - amount` and the member's
     *         own reserved <= newMemberCap. This blocks "exit before slash".
     */
    function requestWithdraw(uint256 amount) external {
        Member storage m = members[msg.sender];
        require(m.isMember, "StakingPool: not a member");
        require(amount > 0 && amount <= m.contribution, "StakingPool: bad amount");
        require(m.withdrawReqAt == 0, "StakingPool: pending request");

        // Capacity invariant must hold *after* the withdrawal.
        uint256 newTotal = totalStake - amount;
        require(activeValue <= newTotal, "StakingPool: would breach capacity");

        // Per-member cap must still cover this member's current reservations.
        uint256 newContribution = m.contribution - amount;
        uint256 newCap = (newContribution * memberCapBps) / 10000;
        require(m.reserved <= newCap, "StakingPool: would breach member cap");

        m.withdrawReqAt  = block.timestamp;
        m.withdrawReqAmt = amount;
        emit WithdrawRequested(msg.sender, amount, block.timestamp + withdrawalDelay);
    }

    function finalizeWithdraw() external nonReentrant {
        Member storage m = members[msg.sender];
        require(m.withdrawReqAt != 0, "StakingPool: no request");
        require(block.timestamp >= m.withdrawReqAt + withdrawalDelay, "StakingPool: too early");

        uint256 amount = m.withdrawReqAmt;
        // The amount could have been reduced by an interim slash; clamp.
        if (amount > m.contribution) {
            amount = m.contribution;
        }

        m.contribution -= amount;
        totalStake     -= amount;
        m.withdrawReqAt = 0;
        m.withdrawReqAmt = 0;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "StakingPool: transfer failed");
        emit WithdrawFinalized(msg.sender, amount);
    }

    // ----------------------------------------------------------------------
    // Vault-callable: reserve / release / slash
    // ----------------------------------------------------------------------

    /// @notice Reserve capacity for a delivery the vault is about to fund.
    function reserve(address courier, uint256 value) external onlyRegisteredVault {
        Member storage m = members[courier];
        require(m.isMember, "StakingPool: courier not a member");

        // Capacity invariant.
        require(activeValue + value <= totalStake, "StakingPool: pool capacity");

        // Per-member cap.
        uint256 cap = (m.contribution * memberCapBps) / 10000;
        require(m.reserved + value <= cap, "StakingPool: member cap");

        m.reserved  += value;
        activeValue += value;
        emit Reserved(msg.sender, courier, value);
    }

    /// @notice Release a reservation on successful or refunded delivery.
    function release(address courier, uint256 value) external onlyRegisteredVault {
        Member storage m = members[courier];
        require(m.isMember, "StakingPool: courier not a member");
        // defensive: clamp in case of bookkeeping divergence
        uint256 r = m.reserved < value ? m.reserved : value;
        uint256 a = activeValue < value ? activeValue : value;
        m.reserved  -= r;
        activeValue -= a;
        emit Released(msg.sender, courier, value);
    }

    /**
     * @notice Slash up to `amount` from the courier. Take from the courier's
     *         own contribution first; if insufficient, draw the remainder
     *         pro-rata from other members' contributions.
     * @return paid Total ETH actually paid out to the vault.
     */
    function slash(address courier, uint256 amount)
        external
        onlyRegisteredVault
        nonReentrant
        returns (uint256 paid)
    {
        Member storage m = members[courier];
        require(m.isMember, "StakingPool: courier not a member");

        uint256 remaining = amount;
        uint256 fromCourier = 0;

        // Step 1: slash courier's own balance.
        if (m.contribution >= remaining) {
            m.contribution -= remaining;
            totalStake     -= remaining;
            fromCourier     = remaining;
            remaining       = 0;
        } else {
            fromCourier     = m.contribution;
            remaining      -= m.contribution;
            totalStake     -= m.contribution;
            m.contribution  = 0;
        }

        // Step 2: pro-rata slash from other members if still owed.
        uint256 fromPool = 0;
        if (remaining > 0) {
            // Compute base = sum of *other* members' contributions.
            uint256 base = 0;
            uint256 n = memberList.length;
            for (uint256 i = 0; i < n; i++) {
                address a = memberList[i];
                if (a != courier) {
                    base += members[a].contribution;
                }
            }
            if (base == 0) {
                // Pool fully drained; vault gets only what was available.
                remaining = 0;
            } else {
                // If pool can't cover the rest, take everything pro-rata to limit.
                uint256 take = remaining > base ? base : remaining;
                uint256 distributed = 0;
                for (uint256 i = 0; i < n; i++) {
                    address a = memberList[i];
                    if (a == courier) continue;
                    uint256 c = members[a].contribution;
                    if (c == 0) continue;
                    // share = take * c / base, last member sweeps the dust
                    uint256 share;
                    if (i == n - 1 || (i == n - 2 && memberList[n - 1] == courier)) {
                        share = take - distributed;
                    } else {
                        share = (take * c) / base;
                    }
                    if (share > c) share = c;
                    members[a].contribution -= share;
                    distributed             += share;
                }
                totalStake -= distributed;
                fromPool    = distributed;
                remaining   = remaining > distributed ? remaining - distributed : 0;
            }
        }

        // Release the reservation associated with this slash (defensive).
        if (m.reserved >= amount) {
            m.reserved  -= amount;
            activeValue -= amount;
        } else {
            activeValue -= m.reserved;
            m.reserved   = 0;
        }

        paid = fromCourier + fromPool;
        if (paid > 0) {
            (bool ok, ) = payable(msg.sender).call{value: paid}("");
            require(ok, "StakingPool: payout failed");
        }
        emit Slashed(msg.sender, courier, paid, fromCourier, fromPool);
    }

    // ----------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------

    function freeCapacityFor(address courier) external view returns (uint256) {
        Member storage m = members[courier];
        if (!m.isMember) return 0;
        uint256 cap = (m.contribution * memberCapBps) / 10000;
        uint256 perMember = cap > m.reserved ? cap - m.reserved : 0;
        uint256 poolFree = totalStake > activeValue ? totalStake - activeValue : 0;
        return perMember < poolFree ? perMember : poolFree;
    }

    function memberCount() external view returns (uint256) {
        return memberList.length;
    }

    // Allow the contract to receive ETH from non-payable calls (defensive).
    receive() external payable {
        revert("StakingPool: use depositStake");
    }
}
