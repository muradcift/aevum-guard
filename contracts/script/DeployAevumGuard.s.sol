// SPDX-License-Identifier: MIT
// Based on Aevum Starter Kit (MIT, PQA Labs) — Deploy.s.sol deployment guard pattern.
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AevumGuardVault} from "../src/AevumGuardVault.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";

/// @notice Deploys AevumGuardVault.
///   - Aevum testnet (44005) and local fork (440050): uses TUSD8_ADDRESS env var or default tUSD8.
///   - Local anvil (31337): deploys MockUSD8 when DEPLOY_MOCK=true (or when no tUSD8 exists at TUSD8_ADDRESS).
contract DeployAevumGuard is Script {
    address constant DEFAULT_TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    uint256 constant ANVIL_CHAIN = 31337;

    function run() external returns (AevumGuardVault vault, address token) {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        address configuredToken = vm.envOr("TUSD8_ADDRESS", DEFAULT_TUSD8);
        bool deployMock = vm.envOr("DEPLOY_MOCK", false);

        if (block.chainid == ANVIL_CHAIN && (deployMock || configuredToken.code.length == 0)) {
            MockUSD8 mock = new MockUSD8();
            mock.mint(deployer, 1_000e6);
            token = address(mock);
        } else {
            require(
                configuredToken.code.length > 0,
                "tUSD8 contract not found on this chain. Check RPC or set TUSD8_ADDRESS."
            );
            token = configuredToken;
        }

        vault = new AevumGuardVault(IERC20(token));
        vm.stopBroadcast();

        console.log("chainId         ", block.chainid);
        console.log("token           ", token);
        console.log("deployer        ", deployer);
        console.log("AevumGuardVault ", address(vault));
    }
}
