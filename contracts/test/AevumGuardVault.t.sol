// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AevumGuardVault} from "../src/AevumGuardVault.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";
import {Signing} from "./Signing.sol";

contract AevumGuardVaultTest is Test {
    MockUSD8 internal token;
    AevumGuardVault internal vault;

    address internal owner;
    uint256 internal ownerKey;
    address internal agent;
    uint256 internal agentKey;
    address internal vendor = makeAddr("vendor");
    address internal rogueVendor = makeAddr("rogueVendor");
    address internal relayer = makeAddr("relayer");

    bytes32 internal constant INVOICE_1 = keccak256("INV-2026-001");
    bytes32 internal constant INVOICE_2 = keccak256("INV-2026-002");

    function setUp() public {
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");

        // Start at a realistic timestamp so day-bucket boundaries are unambiguous.
        vm.warp(1_795_000_000);

        token = new MockUSD8();
        vault = new AevumGuardVault(IERC20(address(token)));

        token.mint(owner, 10_000e6);
    }

    function _createFundedVault(bool enforceAllowlist, uint256 fundAmount) internal returns (uint256 vaultId) {
        vm.startPrank(owner);
        vaultId = vault.createVault("Ops Agent Treasury", enforceAllowlist);
        if (fundAmount > 0) {
            token.approve(address(vault), fundAmount);
            vault.deposit(vaultId, fundAmount);
        }
        vm.stopPrank();
    }

    function _configureAgent(
        uint256 vaultId,
        uint256 perTxLimit,
        uint256 dailyLimit,
        uint256 totalBudget,
        uint64 expiresAt,
        bool allowQueueOverflow
    ) internal {
        vm.prank(owner);
        vault.setPolicy(
            vaultId,
            agent,
            AevumGuardVault.PolicyInput({
                label: "Research & Procurement Agent",
                perTxLimit: perTxLimit,
                dailyLimit: dailyLimit,
                totalBudget: totalBudget,
                expiresAt: expiresAt,
                allowQueueOverflow: allowQueueOverflow
            })
        );
    }

    function _signDeposit(uint256 vaultId, uint256 amount, bytes32 depositRef, uint256 validBefore)
        internal
        view
        returns (AevumGuardVault.DepositAuth memory auth)
    {
        bytes32 nonce = vault.depositNonce(vaultId, depositRef);
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(
            vm,
            ownerKey,
            token.DOMAIN_SEPARATOR(),
            Signing.Auth({
                from: owner,
                to: address(vault),
                value: amount,
                validAfter: 0,
                validBefore: validBefore,
                nonce: nonce
            })
        );
        auth = AevumGuardVault.DepositAuth({
            vaultId: vaultId,
            from: owner,
            amount: amount,
            validAfter: 0,
            validBefore: validBefore,
            depositRef: depositRef,
            v: v,
            r: r,
            s: s
        });
    }

    function _signSpendIntent(uint256 signerKey, AevumGuardVault.SpendIntent memory intent)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AevumGuardVault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        bytes32 typeHash = keccak256(
            "SpendIntent(uint256 vaultId,address agent,address recipient,uint256 amount,bytes32 invoiceRef,string memo,uint256 nonce,uint256 deadline)"
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash,
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        return vm.sign(signerKey, digest);
    }

    function testCreateVaultAndStandardDepositWithdraw() public {
        uint256 vaultId = _createFundedVault(true, 250e6);

        AevumGuardVault.Vault memory v = vault.getVault(vaultId);
        assertEq(v.owner, owner);
        assertEq(v.name, "Ops Agent Treasury");
        assertEq(v.balance, 250e6);
        assertEq(v.reserved, 0);
        assertFalse(v.paused);
        assertTrue(v.enforceAllowlist);
        assertEq(token.balanceOf(address(vault)), 250e6);

        // Non-owner cannot withdraw.
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AevumGuardVault.NotVaultOwner.selector, vaultId, agent));
        vault.withdraw(vaultId, agent, 10e6);

        // Owner withdraws part of the balance.
        vm.prank(owner);
        vault.withdraw(vaultId, owner, 100e6);

        assertEq(vault.getVault(vaultId).balance, 150e6);
        assertEq(token.balanceOf(address(vault)), 150e6);
        assertEq(token.balanceOf(owner), 9_850e6);
    }

    function testGaslessDepositWithAuthorizationEIP3009() public {
        uint256 vaultId1 = _createFundedVault(true, 0);
        vm.prank(owner);
        uint256 vaultId2 = vault.createVault("Second Vault", true);

        bytes32 depositRef = keccak256("dep-1");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        AevumGuardVault.DepositAuth memory auth = _signDeposit(vaultId1, 300e6, depositRef, deadline);

        // Cross-vault redirect fails because nonce binds vaultId.
        auth.vaultId = vaultId2;
        vm.prank(relayer);
        vm.expectRevert(MockUSD8.InvalidSignature.selector);
        vault.depositWithAuthorization(auth);
        auth.vaultId = vaultId1;

        // Valid relayer submission succeeds with zero gas spent by owner.
        vm.prank(relayer);
        vault.depositWithAuthorization(auth);
        assertEq(vault.getVault(vaultId1).balance, 300e6);
        assertEq(token.balanceOf(address(vault)), 300e6);

        // Replay fails.
        vm.prank(relayer);
        vm.expectRevert(MockUSD8.AuthorizationUsedAlready.selector);
        vault.depositWithAuthorization(auth);
    }

    function testAutoApprovedSpendWithinLimits() public {
        uint256 vaultId = _createFundedVault(true, 500e6);
        vm.prank(owner);
        vault.setPayee(vaultId, vendor, true, "Cloud Compute Vendor");
        _configureAgent(vaultId, 50e6, 120e6, 400e6, 0, true);

        vm.prank(agent);
        (uint256 reqId, bool executed) = vault.executeSpend(vaultId, vendor, 45e6, INVOICE_1, "API compute batch");

        assertTrue(executed);
        assertEq(reqId, 0);
        assertEq(token.balanceOf(vendor), 45e6);
        assertEq(vault.getVault(vaultId).balance, 455e6);
        assertEq(vault.remainingDailyLimit(vaultId, agent), 75e6);
        assertEq(vault.getPolicy(vaultId, agent).spentTotal, 45e6);
    }

    function testPayeeAllowlistBlocksUnverifiedRecipient() public {
        uint256 vaultId = _createFundedVault(true, 500e6);
        vm.prank(owner);
        vault.setPayee(vaultId, vendor, true, "Verified Vendor");
        _configureAgent(vaultId, 50e6, 100e6, 500e6, 0, true);

        AevumGuardVault.PayeeInfo memory info = vault.getPayee(vaultId, vendor);
        assertTrue(info.approved);
        assertEq(info.confirmationHash, keccak256(abi.encodePacked("Verified Vendor", vendor)));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AevumGuardVault.PayeeNotAllowlisted.selector, rogueVendor));
        vault.executeSpend(vaultId, rogueVendor, 10e6, INVOICE_1, "Unverified transfer");
    }

    function testOverPerTxLimitQueuesAndHumanApproves() public {
        uint256 vaultId = _createFundedVault(true, 500e6);
        vm.prank(owner);
        vault.setPayee(vaultId, vendor, true, "Vendor A");
        _configureAgent(vaultId, 50e6, 200e6, 500e6, 0, true);

        vm.prank(agent);
        (uint256 reqId, bool executed) = vault.executeSpend(vaultId, vendor, 80e6, INVOICE_1, "Hardware GPU rent");

        assertFalse(executed);
        assertEq(reqId, 1);
        assertEq(token.balanceOf(vendor), 0);

        AevumGuardVault.Vault memory v = vault.getVault(vaultId);
        assertEq(v.balance, 420e6);
        assertEq(v.reserved, 80e6);

        AevumGuardVault.SpendRequest memory req = vault.getRequest(reqId);
        assertEq(uint8(req.status), uint8(AevumGuardVault.RequestStatus.Pending));
        assertEq(req.reasonCode, 1); // exceeds perTxLimit

        vm.prank(owner);
        vault.approveRequest(reqId);

        assertEq(token.balanceOf(vendor), 80e6);
        assertEq(vault.getVault(vaultId).reserved, 0);
        assertEq(vault.getPolicy(vaultId, agent).spentTotal, 80e6);
        assertEq(uint8(vault.getRequest(reqId).status), uint8(AevumGuardVault.RequestStatus.Approved));
    }

    function testOverDailyLimitQueuesAndResetsNextDay() public {
        uint256 vaultId = _createFundedVault(true, 500e6);
        vm.prank(owner);
        vault.setPayee(vaultId, vendor, true, "Vendor A");
        _configureAgent(vaultId, 60e6, 100e6, 500e6, 0, true);

        vm.prank(agent);
        (, bool ok1) = vault.executeSpend(vaultId, vendor, 60e6, INVOICE_1, "Spend 1");
        assertTrue(ok1);
        assertEq(vault.remainingDailyLimit(vaultId, agent), 40e6);

        // Next 50 tUSD8 spend fits perTx (60) but exceeds remaining daily (40) -> queued.
        vm.prank(agent);
        (uint256 reqId, bool ok2) = vault.executeSpend(vaultId, vendor, 50e6, INVOICE_2, "Spend 2");
        assertFalse(ok2);
        assertEq(vault.getRequest(reqId).reasonCode, 2); // exceeds dailyLimit

        // Advance 1 day -> daily quota resets and autonomous spend works again.
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(vault.remainingDailyLimit(vaultId, agent), 100e6);

        vm.prank(agent);
        (, bool ok3) = vault.executeSpend(vaultId, vendor, 50e6, keccak256("INV-3"), "Next day spend");
        assertTrue(ok3);
        assertEq(vault.remainingDailyLimit(vaultId, agent), 50e6);
    }

    function testTotalBudgetHardCapCannotBeBypassed() public {
        uint256 vaultId = _createFundedVault(true, 500e6);
        vm.prank(owner);
        vault.setPayee(vaultId, vendor, true, "Vendor A");
        _configureAgent(vaultId, 80e6, 100e6, 100e6, 0, true);

        vm.prank(agent);
        vault.executeSpend(vaultId, vendor, 80e6, INVOICE_1, "First spend");

        // Even after daily window resets, totalBudget caps remaining lifetime spend at 20 tUSD8.
        vm.warp(vm.getBlockTimestamp() + 1 days);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AevumGuardVault.TotalBudgetExceeded.selector, 20e6, 30e6));
        vault.executeSpend(vaultId, vendor, 30e6, INVOICE_2, "Over total budget");
    }

    function testPolicyExpiryBlocksSpend() public {
        uint256 vaultId = _createFundedVault(true, 500e6);
        vm.prank(owner);
        vault.setPayee(vaultId, vendor, true, "Vendor A");
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 expiry = uint64(vm.getBlockTimestamp() + 2 hours);
        _configureAgent(vaultId, 50e6, 100e6, 500e6, expiry, false);

        vm.warp(expiry + 1);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AevumGuardVault.PolicyExpired.selector, expiry, uint256(expiry) + 1)
        );
        vault.executeSpend(vaultId, vendor, 10e6, INVOICE_1, "After expiry");
    }

    function testRevokeAgentBlocksImmediately() public {
        uint256 vaultId = _createFundedVault(true, 500e6);
        vm.prank(owner);
        vault.setPayee(vaultId, vendor, true, "Vendor A");
        _configureAgent(vaultId, 50e6, 100e6, 500e6, 0, false);

        vm.prank(owner);
        vault.revokeAgent(vaultId, agent);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AevumGuardVault.AgentNotActive.selector, vaultId, agent));
        vault.executeSpend(vaultId, vendor, 10e6, INVOICE_1, "Revoked spend");
    }

    function testRejectQueuedRequestUnlocksBalanceEvenWhilePaused() public {
        uint256 vaultId = _createFundedVault(true, 500e6);
        vm.prank(owner);
        vault.setPayee(vaultId, vendor, true, "Vendor A");
        _configureAgent(vaultId, 25e6, 100e6, 500e6, 0, true);

        vm.prank(agent);
        (uint256 reqId,) = vault.executeSpend(vaultId, vendor, 75e6, INVOICE_1, "Large request");

        vm.prank(owner);
        vault.setVaultPaused(vaultId, true);

        vm.prank(owner);
        vault.rejectRequest(reqId);

        AevumGuardVault.Vault memory v = vault.getVault(vaultId);
        assertEq(v.reserved, 0);
        assertEq(v.balance, 500e6);
        assertEq(uint8(vault.getRequest(reqId).status), uint8(AevumGuardVault.RequestStatus.Rejected));
    }

    function testApproveBlockedIfPayeeRevokedAfterQueue() public {
        uint256 vaultId = _createFundedVault(true, 500e6);
        vm.prank(owner);
        vault.setPayee(vaultId, vendor, true, "Vendor A");
        _configureAgent(vaultId, 25e6, 100e6, 500e6, 0, true);

        vm.prank(agent);
        (uint256 reqId,) = vault.executeSpend(vaultId, vendor, 60e6, INVOICE_1, "Queued while approved");

        // Owner later un-approves the payee.
        vm.prank(owner);
        vault.setPayee(vaultId, vendor, false, "Vendor A");

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AevumGuardVault.PayeeNotAllowlisted.selector, vendor));
        vault.approveRequest(reqId);

        // Owner can still reject to reclaim reserved balance.
        vm.prank(owner);
        vault.rejectRequest(reqId);
        assertEq(vault.getVault(vaultId).balance, 500e6);
    }

    function testCancelExpiredRequestUnlocksFunds() public {
        uint256 vaultId = _createFundedVault(true, 500e6);
        vm.prank(owner);
        vault.setPayee(vaultId, vendor, true, "Vendor A");
        _configureAgent(vaultId, 25e6, 100e6, 500e6, 0, true);

        vm.prank(agent);
        (uint256 reqId,) = vault.executeSpend(vaultId, vendor, 70e6, INVOICE_1, "Will expire");

        vm.warp(vm.getBlockTimestamp() + vault.REQUEST_TTL() + 1);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AevumGuardVault.RequestExpired.selector, reqId));
        vault.approveRequest(reqId);

        // Anyone can cancel an expired pending request to unlock funds back into vault.balance.
        vm.prank(relayer);
        vault.cancelExpiredRequest(reqId);

        assertEq(vault.getVault(vaultId).reserved, 0);
        assertEq(vault.getVault(vaultId).balance, 500e6);
        assertEq(uint8(vault.getRequest(reqId).status), uint8(AevumGuardVault.RequestStatus.Cancelled));
    }

    function testKillSwitchBlocksSpendsAndApprovalsButAllowsOwnerWithdraw() public {
        uint256 vaultId = _createFundedVault(true, 500e6);
        vm.prank(owner);
        vault.setPayee(vaultId, vendor, true, "Vendor A");
        _configureAgent(vaultId, 25e6, 100e6, 500e6, 0, true);

        vm.prank(agent);
        (uint256 reqId,) = vault.executeSpend(vaultId, vendor, 60e6, INVOICE_1, "Pending before pause");

        vm.prank(owner);
        vault.setVaultPaused(vaultId, true);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AevumGuardVault.VaultPaused.selector, vaultId));
        vault.executeSpend(vaultId, vendor, 10e6, INVOICE_2, "Blocked by pause");

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AevumGuardVault.VaultPaused.selector, vaultId));
        vault.approveRequest(reqId);

        // Owner can still withdraw available balance while paused.
        vm.prank(owner);
        vault.withdraw(vaultId, owner, 440e6);
        assertEq(vault.getVault(vaultId).balance, 0);
        assertEq(vault.getVault(vaultId).reserved, 60e6);
    }

    function testGaslessAgentSpendIntentEIP712() public {
        uint256 vaultId = _createFundedVault(true, 500e6);
        vm.prank(owner);
        vault.setPayee(vaultId, vendor, true, "Vendor A");
        _configureAgent(vaultId, 50e6, 150e6, 500e6, 0, true);

        uint256 deadline = vm.getBlockTimestamp() + 15 minutes;
        AevumGuardVault.SpendIntent memory intent = AevumGuardVault.SpendIntent({
            vaultId: vaultId,
            agent: agent,
            recipient: vendor,
            amount: 35e6,
            invoiceRef: INVOICE_1,
            memo: "Gasless agent settlement",
            nonce: 0,
            deadline: deadline
        });

        // Wrong signer reverts.
        (uint8 badV, bytes32 badR, bytes32 badS) = _signSpendIntent(ownerKey, intent);
        vm.prank(relayer);
        vm.expectRevert(AevumGuardVault.InvalidAgentSignature.selector);
        vault.executeSpendWithSignature(intent, badV, badR, badS);

        // Valid signature succeeds via relayer.
        (uint8 v, bytes32 r, bytes32 s) = _signSpendIntent(agentKey, intent);
        vm.prank(relayer);
        (uint256 reqId, bool executed) = vault.executeSpendWithSignature(intent, v, r, s);
        assertTrue(executed);
        assertEq(reqId, 0);
        assertEq(vault.agentNonces(agent), 1);
        assertEq(token.balanceOf(vendor), 35e6);

        // Replay fails due to nonce mismatch.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AevumGuardVault.InvalidNonce.selector, 1, 0));
        vault.executeSpendWithSignature(intent, v, r, s);

        // Expired intent fails.
        AevumGuardVault.SpendIntent memory expiredIntent = intent;
        expiredIntent.nonce = 1;
        expiredIntent.deadline = vm.getBlockTimestamp() - 1;
        (uint8 ev, bytes32 er, bytes32 es) = _signSpendIntent(agentKey, expiredIntent);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(AevumGuardVault.IntentExpired.selector, expiredIntent.deadline, vm.getBlockTimestamp())
        );
        vault.executeSpendWithSignature(expiredIntent, ev, er, es);
    }

    function testFuzzSolvencyInvariant(
        uint256 depositAmt,
        uint256 smallSpendAmt,
        uint256 largeSpendAmt,
        uint256 withdrawAmt,
        bool approveQueued
    ) public {
        depositAmt = bound(depositAmt, 120e6, 10_000e6);
        smallSpendAmt = bound(smallSpendAmt, 1e6, 50e6);
        largeSpendAmt = bound(largeSpendAmt, 51e6, depositAmt - smallSpendAmt);

        uint256 vaultId1 = _createFundedVault(true, depositAmt);
        vm.startPrank(owner);
        uint256 vaultId2 = vault.createVault("Vault 2", false);
        token.mint(owner, 500e6);
        token.approve(address(vault), 500e6);
        vault.deposit(vaultId2, 500e6);
        vault.setPayee(vaultId1, vendor, true, "Vendor A");
        vm.stopPrank();

        _configureAgent(vaultId1, 50e6, depositAmt, depositAmt, 0, true);

        vm.prank(agent);
        vault.executeSpend(vaultId1, vendor, smallSpendAmt, INVOICE_1, "Fuzz small");

        vm.prank(agent);
        (uint256 reqId, bool executed) = vault.executeSpend(vaultId1, vendor, largeSpendAmt, INVOICE_2, "Fuzz large");
        assertFalse(executed);

        vm.prank(owner);
        if (approveQueued) {
            vault.approveRequest(reqId);
        } else {
            vault.rejectRequest(reqId);
        }

        uint256 available = vault.getVault(vaultId1).balance;
        if (available > 0) {
            withdrawAmt = bound(withdrawAmt, 1, available);
            vm.prank(owner);
            vault.withdraw(vaultId1, owner, withdrawAmt);
        }

        AevumGuardVault.Vault memory v1 = vault.getVault(vaultId1);
        AevumGuardVault.Vault memory v2 = vault.getVault(vaultId2);
        assertEq(token.balanceOf(address(vault)), v1.balance + v1.reserved + v2.balance + v2.reserved);
    }
}
