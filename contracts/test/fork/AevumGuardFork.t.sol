// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AevumGuardVault} from "../../src/AevumGuardVault.sol";
import {Signing} from "../Signing.sol";

interface ITUSD8 is IERC20 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address, bytes32) external view returns (bool);
}

/// @notice Runs AevumGuardVault against the REAL tUSD8 on a local fork of Aevum testnet (chain 44005).
///         Run with: forge test --match-contract AevumGuardForkTest --fork-url https://rpc-test.qday.info -vv
contract AevumGuardForkTest is Test {
    ITUSD8 internal constant TUSD8 = ITUSD8(0x456569838f1d43009A91ebA4263147Afd7233483);

    AevumGuardVault internal vault;
    address internal owner;
    uint256 internal ownerKey;
    address internal agent;
    uint256 internal agentKey;
    address internal vendor = makeAddr("forkVendor");
    address internal relayer = makeAddr("forkRelayer");

    function setUp() public {
        if (block.chainid != 44005 || address(TUSD8).code.length == 0) {
            vm.skip(true);
            return;
        }
        (owner, ownerKey) = makeAddrAndKey("forkOwner");
        (agent, agentKey) = makeAddrAndKey("forkAgent");
        vault = new AevumGuardVault(TUSD8);
        deal(address(TUSD8), owner, 100e6);
    }

    function test_realTusd8_domain() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("tUSD8"),
                keccak256("2"),
                uint256(44005),
                address(TUSD8)
            )
        );
        assertEq(TUSD8.DOMAIN_SEPARATOR(), expected);
    }

    function test_realTusd8_gaslessDepositAndGuardedSpend() public {
        vm.startPrank(owner);
        uint256 vaultId = vault.createVault("Fork AI Treasury", true);
        vault.setPayee(vaultId, vendor, true, "Approved Vendor");
        vault.setPolicy(
            vaultId,
            agent,
            AevumGuardVault.PolicyInput({
                label: "Fork Agent",
                perTxLimit: 20e6,
                dailyLimit: 50e6,
                totalBudget: 100e6,
                expiresAt: 0,
                allowQueueOverflow: true
            })
        );
        vm.stopPrank();

        uint256 deadline = vm.getBlockTimestamp() + 1 hours;

        // 1. Gasless EIP-3009 deposit into AevumGuardVault using real tUSD8.
        {
            bytes32 depositRef = keccak256("fork-dep-1");
            bytes32 nonce = vault.depositNonce(vaultId, depositRef);
            (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(
                vm,
                ownerKey,
                TUSD8.DOMAIN_SEPARATOR(),
                Signing.Auth({
                    from: owner,
                    to: address(vault),
                    value: 60e6,
                    validAfter: 0,
                    validBefore: deadline,
                    nonce: nonce
                })
            );

            vm.prank(relayer);
            vault.depositWithAuthorization(
                AevumGuardVault.DepositAuth({
                    vaultId: vaultId,
                    from: owner,
                    amount: 60e6,
                    validAfter: 0,
                    validBefore: deadline,
                    depositRef: depositRef,
                    v: v,
                    r: r,
                    s: s
                })
            );
            assertTrue(TUSD8.authorizationState(owner, nonce));
        }

        assertEq(TUSD8.balanceOf(address(vault)), 60e6);
        assertEq(TUSD8.balanceOf(owner), 40e6);
        assertEq(vault.getVault(vaultId).balance, 60e6);

        // 2. Gasless EIP-712 SpendIntent auto-executes within 20 tUSD8 limit.
        AevumGuardVault.SpendIntent memory intent = AevumGuardVault.SpendIntent({
            vaultId: vaultId,
            agent: agent,
            recipient: vendor,
            amount: 15e6,
            invoiceRef: keccak256("FORK-INV-1"),
            memo: "Fork agent spend",
            nonce: 0,
            deadline: deadline
        });
        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(agentKey, vault.spendIntentDigest(intent));

        vm.prank(relayer);
        (uint256 reqId, bool executed) = vault.executeSpendWithSignature(intent, av, ar, as_);
        assertTrue(executed);
        assertEq(reqId, 0);
        assertEq(TUSD8.balanceOf(vendor), 15e6);
        assertEq(vault.getVault(vaultId).balance, 45e6);
    }
}
