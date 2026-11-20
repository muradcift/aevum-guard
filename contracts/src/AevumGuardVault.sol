// SPDX-License-Identifier: MIT
// Based on Aevum Starter Kit (MIT, PQA Labs) — IERC3009 interface adapted from Checkout.sol.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice EIP-3009 (USDC-style) signed transfers implemented by tUSD8 on Aevum testnet.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title AevumGuardVault
/// @notice Programmable tUSD8 treasury with on-chain spend limits, Confirmation of Payee allowlists,
///         human-in-the-loop approval queues, gasless EIP-3009 funding, and gasless EIP-712 AI agent intents.
contract AevumGuardVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("AevumGuardVault");
    bytes32 private constant _VERSION_HASH = keccak256("1");

    bytes32 public constant SPEND_INTENT_TYPEHASH = keccak256(
        "SpendIntent(uint256 vaultId,address agent,address recipient,uint256 amount,bytes32 invoiceRef,string memo,uint256 nonce,uint256 deadline)"
    );

    uint64 public constant REQUEST_TTL = 24 hours;

    IERC20 public immutable token;
    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;

    uint256 public nextVaultId = 1;
    uint256 public nextRequestId = 1;

    struct Vault {
        address owner;
        string name;
        uint256 balance;
        uint256 reserved;
        bool paused;
        bool enforceAllowlist;
    }

    struct PayeeInfo {
        bool approved;
        string label;
        bytes32 confirmationHash;
    }

    struct Policy {
        bool active;
        string label;
        uint256 perTxLimit;
        uint256 dailyLimit;
        uint256 totalBudget;
        uint256 spentTotal;
        uint256 spentToday;
        uint64 lastSpendDay;
        uint64 expiresAt;
        bool allowQueueOverflow;
    }

    struct PolicyInput {
        string label;
        uint256 perTxLimit;
        uint256 dailyLimit;
        uint256 totalBudget;
        uint64 expiresAt;
        bool allowQueueOverflow;
    }

    enum RequestStatus {
        None,
        Pending,
        Approved,
        Rejected,
        Cancelled
    }

    struct SpendRequest {
        uint256 vaultId;
        address agent;
        address recipient;
        uint256 amount;
        bytes32 invoiceRef;
        string memo;
        uint64 createdAt;
        uint64 expiresAt;
        uint8 reasonCode;
        RequestStatus status;
    }

    struct DepositAuth {
        uint256 vaultId;
        address from;
        uint256 amount;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 depositRef;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct SpendIntent {
        uint256 vaultId;
        address agent;
        address recipient;
        uint256 amount;
        bytes32 invoiceRef;
        string memo;
        uint256 nonce;
        uint256 deadline;
    }

    struct SpendCtx {
        uint256 vaultId;
        address agent;
        address recipient;
        uint256 amount;
        bytes32 invoiceRef;
        string memo;
    }

    mapping(uint256 vaultId => Vault) private _vaults;
    mapping(uint256 vaultId => mapping(address payee => PayeeInfo)) private _payees;
    mapping(uint256 vaultId => mapping(address agent => Policy)) private _policies;
    mapping(uint256 requestId => SpendRequest) private _requests;
    mapping(address agent => uint256 nonce) public agentNonces;

    event VaultCreated(uint256 indexed vaultId, address indexed owner, string name, bool enforceAllowlist);
    event Deposited(uint256 indexed vaultId, address indexed from, uint256 amount, bool gasless, bytes32 depositRef);
    event Withdrawn(uint256 indexed vaultId, address indexed to, uint256 amount);
    event VaultPauseChanged(uint256 indexed vaultId, bool paused);
    event AllowlistModeChanged(uint256 indexed vaultId, bool enforceAllowlist);
    event PayeeUpdated(
        uint256 indexed vaultId, address indexed payee, bool approved, string label, bytes32 confirmationHash
    );
    event PolicyUpdated(
        uint256 indexed vaultId,
        address indexed agent,
        string label,
        uint256 perTxLimit,
        uint256 dailyLimit,
        uint256 totalBudget,
        uint64 expiresAt,
        bool allowQueueOverflow
    );
    event AgentRevoked(uint256 indexed vaultId, address indexed agent);
    event SpendExecuted(
        uint256 indexed vaultId,
        address indexed agent,
        address indexed recipient,
        uint256 amount,
        bytes32 invoiceRef,
        string memo,
        uint256 requestId
    );
    event SpendQueued(
        uint256 indexed requestId,
        uint256 indexed vaultId,
        address indexed agent,
        address recipient,
        uint256 amount,
        bytes32 invoiceRef,
        string memo,
        uint8 reasonCode
    );
    event RequestApproved(uint256 indexed requestId, uint256 indexed vaultId, address indexed approver);
    event RequestRejected(uint256 indexed requestId, uint256 indexed vaultId, address indexed approver);
    event RequestCancelled(uint256 indexed requestId, uint256 indexed vaultId);

    error ZeroAddress();
    error ZeroAmount();
    error VaultNotFound(uint256 vaultId);
    error NotVaultOwner(uint256 vaultId, address caller);
    error VaultPaused(uint256 vaultId);
    error AgentNotActive(uint256 vaultId, address agent);
    error PolicyExpired(uint64 expiresAt, uint256 currentTime);
    error PayeeNotAllowlisted(address recipient);
    error InsufficientVaultBalance(uint256 available, uint256 required);
    error TotalBudgetExceeded(uint256 remainingBudget, uint256 requested);
    error SpendLimitExceeded(uint256 amount, uint256 perTxLimit, uint256 remainingDaily);
    error RequestNotFound(uint256 requestId);
    error RequestNotPending(uint256 requestId);
    error RequestExpired(uint256 requestId);
    error RequestNotExpired(uint256 requestId);
    error IntentExpired(uint256 deadline, uint256 currentTime);
    error InvalidNonce(uint256 expected, uint256 actual);
    error InvalidAgentSignature();

    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    function createVault(string calldata name, bool enforceAllowlist) external returns (uint256 vaultId) {
        vaultId = nextVaultId++;
        _vaults[vaultId] = Vault({
            owner: msg.sender,
            name: name,
            balance: 0,
            reserved: 0,
            paused: false,
            enforceAllowlist: enforceAllowlist
        });
        emit VaultCreated(vaultId, msg.sender, name, enforceAllowlist);
    }

    function deposit(uint256 vaultId, uint256 amount) external nonReentrant {
        _requireVault(vaultId);
        if (amount == 0) revert ZeroAmount();
        _vaults[vaultId].balance += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(vaultId, msg.sender, amount, false, bytes32(0));
    }

    function depositWithAuthorization(DepositAuth calldata auth) external nonReentrant {
        _requireVault(auth.vaultId);
        if (auth.from == address(0)) revert ZeroAddress();
        if (auth.amount == 0) revert ZeroAmount();

        bytes32 nonce = depositNonce(auth.vaultId, auth.depositRef);
        _vaults[auth.vaultId].balance += auth.amount;
        IERC3009(address(token)).receiveWithAuthorization(
            auth.from, address(this), auth.amount, auth.validAfter, auth.validBefore, nonce, auth.v, auth.r, auth.s
        );
        emit Deposited(auth.vaultId, auth.from, auth.amount, true, auth.depositRef);
    }

    function depositNonce(uint256 vaultId, bytes32 depositRef) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), "AEVUM_GUARD_DEPOSIT", vaultId, depositRef));
    }

    /// @notice Withdraws available funds from a vault. Intentionally allowed while paused so owner funds cannot be locked.
    function withdraw(uint256 vaultId, address to, uint256 amount) external nonReentrant {
        Vault storage vault = _requireVaultOwner(vaultId);
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (vault.balance < amount) revert InsufficientVaultBalance(vault.balance, amount);

        vault.balance -= amount;
        token.safeTransfer(to, amount);
        emit Withdrawn(vaultId, to, amount);
    }

    function setVaultPaused(uint256 vaultId, bool paused_) external {
        Vault storage vault = _requireVaultOwner(vaultId);
        vault.paused = paused_;
        emit VaultPauseChanged(vaultId, paused_);
    }

    function setEnforceAllowlist(uint256 vaultId, bool enforce) external {
        Vault storage vault = _requireVaultOwner(vaultId);
        vault.enforceAllowlist = enforce;
        emit AllowlistModeChanged(vaultId, enforce);
    }

    function setPayee(uint256 vaultId, address payee, bool approved, string calldata label) external {
        _requireVaultOwner(vaultId);
        if (payee == address(0)) revert ZeroAddress();

        bytes32 confirmationHash = keccak256(abi.encodePacked(label, payee));
        _payees[vaultId][payee] = PayeeInfo({approved: approved, label: label, confirmationHash: confirmationHash});
        emit PayeeUpdated(vaultId, payee, approved, label, confirmationHash);
    }

    function setPolicy(uint256 vaultId, address agent, PolicyInput calldata input) external {
        _requireVaultOwner(vaultId);
        if (agent == address(0)) revert ZeroAddress();

        Policy storage p = _policies[vaultId][agent];
        p.active = true;
        p.label = input.label;
        p.perTxLimit = input.perTxLimit;
        p.dailyLimit = input.dailyLimit;
        p.totalBudget = input.totalBudget;
        p.expiresAt = input.expiresAt;
        p.allowQueueOverflow = input.allowQueueOverflow;

        emit PolicyUpdated(
            vaultId,
            agent,
            input.label,
            input.perTxLimit,
            input.dailyLimit,
            input.totalBudget,
            input.expiresAt,
            input.allowQueueOverflow
        );
    }

    function revokeAgent(uint256 vaultId, address agent) external {
        _requireVaultOwner(vaultId);
        if (agent == address(0)) revert ZeroAddress();
        _policies[vaultId][agent].active = false;
        emit AgentRevoked(vaultId, agent);
    }

    function executeSpend(
        uint256 vaultId,
        address recipient,
        uint256 amount,
        bytes32 invoiceRef,
        string calldata memo
    ) external nonReentrant returns (uint256 requestId, bool executedImmediately) {
        return _processSpend(
            SpendCtx({
                vaultId: vaultId,
                agent: msg.sender,
                recipient: recipient,
                amount: amount,
                invoiceRef: invoiceRef,
                memo: memo
            })
        );
    }

    function executeSpendWithSignature(SpendIntent calldata intent, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        returns (uint256 requestId, bool executedImmediately)
    {
        if (intent.agent == address(0)) revert ZeroAddress();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > intent.deadline) revert IntentExpired(intent.deadline, block.timestamp);

        uint256 expectedNonce = agentNonces[intent.agent];
        if (intent.nonce != expectedNonce) revert InvalidNonce(expectedNonce, intent.nonce);

        bytes32 digest = spendIntentDigest(intent);
        if (ECDSA.recover(digest, v, r, s) != intent.agent) revert InvalidAgentSignature();

        agentNonces[intent.agent] = expectedNonce + 1;
        return _processSpend(
            SpendCtx({
                vaultId: intent.vaultId,
                agent: intent.agent,
                recipient: intent.recipient,
                amount: intent.amount,
                invoiceRef: intent.invoiceRef,
                memo: intent.memo
            })
        );
    }

    function approveRequest(uint256 requestId) external nonReentrant {
        SpendRequest storage req = _requests[requestId];
        if (req.status == RequestStatus.None) revert RequestNotFound(requestId);
        if (req.status != RequestStatus.Pending) revert RequestNotPending(requestId);

        Vault storage vault = _requireVaultOwner(req.vaultId);
        if (vault.paused) revert VaultPaused(req.vaultId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > req.expiresAt) revert RequestExpired(requestId);
        if (vault.enforceAllowlist && !_payees[req.vaultId][req.recipient].approved) {
            revert PayeeNotAllowlisted(req.recipient);
        }

        Policy storage policy = _policies[req.vaultId][req.agent];
        if (policy.totalBudget != 0 && policy.spentTotal + req.amount > policy.totalBudget) {
            uint256 remainingBudget = policy.totalBudget > policy.spentTotal ? policy.totalBudget - policy.spentTotal : 0;
            revert TotalBudgetExceeded(remainingBudget, req.amount);
        }

        req.status = RequestStatus.Approved;
        vault.reserved -= req.amount;
        policy.spentTotal += req.amount;

        token.safeTransfer(req.recipient, req.amount);

        emit RequestApproved(requestId, req.vaultId, msg.sender);
        emit SpendExecuted(req.vaultId, req.agent, req.recipient, req.amount, req.invoiceRef, req.memo, requestId);
    }

    /// @notice Rejects a pending request and returns reserved funds to the vault balance. Allowed even while paused.
    function rejectRequest(uint256 requestId) external nonReentrant {
        SpendRequest storage req = _requests[requestId];
        if (req.status == RequestStatus.None) revert RequestNotFound(requestId);
        if (req.status != RequestStatus.Pending) revert RequestNotPending(requestId);

        Vault storage vault = _requireVaultOwner(req.vaultId);
        req.status = RequestStatus.Rejected;
        vault.reserved -= req.amount;
        vault.balance += req.amount;

        emit RequestRejected(requestId, req.vaultId, msg.sender);
    }

    function cancelExpiredRequest(uint256 requestId) external nonReentrant {
        SpendRequest storage req = _requests[requestId];
        if (req.status == RequestStatus.None) revert RequestNotFound(requestId);
        if (req.status != RequestStatus.Pending) revert RequestNotPending(requestId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= req.expiresAt) revert RequestNotExpired(requestId);

        Vault storage vault = _vaults[req.vaultId];
        req.status = RequestStatus.Cancelled;
        vault.reserved -= req.amount;
        vault.balance += req.amount;

        emit RequestCancelled(requestId, req.vaultId);
    }

    function getVault(uint256 vaultId) external view returns (Vault memory) {
        return _vaults[vaultId];
    }

    function getPolicy(uint256 vaultId, address agent) external view returns (Policy memory) {
        return _policies[vaultId][agent];
    }

    function getPayee(uint256 vaultId, address payee) external view returns (PayeeInfo memory) {
        return _payees[vaultId][payee];
    }

    function getRequest(uint256 requestId) external view returns (SpendRequest memory) {
        return _requests[requestId];
    }

    function remainingDailyLimit(uint256 vaultId, address agent) external view returns (uint256) {
        Policy storage policy = _policies[vaultId][agent];
        // forge-lint: disable-next-line(unsafe-typecast,block-timestamp)
        uint64 currentDay = uint64(block.timestamp / 1 days);
        uint256 spent = currentDay > policy.lastSpendDay ? 0 : policy.spentToday;
        return policy.dailyLimit > spent ? policy.dailyLimit - spent : 0;
    }

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    function spendIntentDigest(SpendIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                SPEND_INTENT_TYPEHASH,
                intent.vaultId,
                intent.agent,
                intent.recipient,
                intent.amount,
                intent.invoiceRef,
                keccak256(bytes(intent.memo)),
                intent.nonce,
                intent.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _processSpend(SpendCtx memory ctx)
        private
        returns (uint256 requestId, bool executedImmediately)
    {
        Vault storage vault = _requireVault(ctx.vaultId);
        if (vault.paused) revert VaultPaused(ctx.vaultId);
        if (ctx.recipient == address(0)) revert ZeroAddress();
        if (ctx.amount == 0) revert ZeroAmount();

        Policy storage policy = _policies[ctx.vaultId][ctx.agent];
        if (!policy.active) revert AgentNotActive(ctx.vaultId, ctx.agent);
        // forge-lint: disable-next-line(block-timestamp)
        if (policy.expiresAt != 0 && block.timestamp > policy.expiresAt) {
            revert PolicyExpired(policy.expiresAt, block.timestamp);
        }
        if (vault.enforceAllowlist && !_payees[ctx.vaultId][ctx.recipient].approved) {
            revert PayeeNotAllowlisted(ctx.recipient);
        }
        if (vault.balance < ctx.amount) revert InsufficientVaultBalance(vault.balance, ctx.amount);
        if (policy.totalBudget != 0 && policy.spentTotal + ctx.amount > policy.totalBudget) {
            uint256 remainingBudget = policy.totalBudget > policy.spentTotal ? policy.totalBudget - policy.spentTotal : 0;
            revert TotalBudgetExceeded(remainingBudget, ctx.amount);
        }

        // forge-lint: disable-next-line(unsafe-typecast,block-timestamp)
        uint64 currentDay = uint64(block.timestamp / 1 days);
        if (currentDay > policy.lastSpendDay) {
            policy.spentToday = 0;
            policy.lastSpendDay = currentDay;
        }

        bool exceedsPerTx = ctx.amount > policy.perTxLimit;
        bool exceedsDaily = policy.spentToday + ctx.amount > policy.dailyLimit;

        if (!exceedsPerTx && !exceedsDaily) {
            vault.balance -= ctx.amount;
            policy.spentToday += ctx.amount;
            policy.spentTotal += ctx.amount;
            token.safeTransfer(ctx.recipient, ctx.amount);
            emit SpendExecuted(ctx.vaultId, ctx.agent, ctx.recipient, ctx.amount, ctx.invoiceRef, ctx.memo, 0);
            return (0, true);
        }

        if (!policy.allowQueueOverflow) {
            uint256 remDaily = policy.dailyLimit > policy.spentToday ? policy.dailyLimit - policy.spentToday : 0;
            revert SpendLimitExceeded(ctx.amount, policy.perTxLimit, remDaily);
        }

        uint8 reasonCode = (exceedsPerTx ? 1 : 0) | (exceedsDaily ? 2 : 0);
        vault.balance -= ctx.amount;
        vault.reserved += ctx.amount;

        requestId = _enqueueRequest(ctx, reasonCode);
        return (requestId, false);
    }

    function _enqueueRequest(SpendCtx memory ctx, uint8 reasonCode) private returns (uint256 requestId) {
        requestId = nextRequestId++;
        // forge-lint: disable-next-line(unsafe-typecast,block-timestamp)
        uint64 createdAt = uint64(block.timestamp);
        uint64 expiresAt = createdAt + REQUEST_TTL;

        _requests[requestId] = SpendRequest({
            vaultId: ctx.vaultId,
            agent: ctx.agent,
            recipient: ctx.recipient,
            amount: ctx.amount,
            invoiceRef: ctx.invoiceRef,
            memo: ctx.memo,
            createdAt: createdAt,
            expiresAt: expiresAt,
            reasonCode: reasonCode,
            status: RequestStatus.Pending
        });

        emit SpendQueued(
            requestId, ctx.vaultId, ctx.agent, ctx.recipient, ctx.amount, ctx.invoiceRef, ctx.memo, reasonCode
        );
    }

    function _requireVault(uint256 vaultId) private view returns (Vault storage vault) {
        vault = _vaults[vaultId];
        if (vault.owner == address(0)) revert VaultNotFound(vaultId);
    }

    function _requireVaultOwner(uint256 vaultId) private view returns (Vault storage vault) {
        vault = _requireVault(vaultId);
        if (vault.owner != msg.sender) revert NotVaultOwner(vaultId, msg.sender);
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(_EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)));
    }
}
