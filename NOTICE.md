# Third-party notices

AevumGuard is MIT licensed (see [LICENSE](LICENSE)).
**Based on [Aevum Starter Kit](https://github.com/qday-io/aevum-starter-kit) (MIT License, Copyright © 2026 PQA Labs)**, retaining its chain configuration (`packages/aevum`), `MockUSD8.sol`, `tools/check-shanghai.mjs`, and chunked log utilities.

## Solidity libraries (`contracts/lib`, git submodules)

| Project | Version | License | Source |
|---|---|---|---|
| forge-std | v1.9.6 | MIT or Apache-2.0 | https://github.com/foundry-rs/forge-std |
| OpenZeppelin Contracts | v5.1.0 | MIT | https://github.com/OpenZeppelin/openzeppelin-contracts |

## JavaScript packages (direct dependencies)

| Package | Version | License | Used in |
|---|---|---|---|
| next | 16.4.3 | MIT | web |
| react, react-dom | 19.2.0 | MIT | web |
| @rainbow-me/rainbowkit | 2.2.11 | MIT | web |
| wagmi | 2.19.5 | MIT | web |
| @tanstack/react-query | 5.90.2 | MIT | web |
| viem | 2.57.12 | MIT | web, examples, packages/aevum |
| tsx | 4.23.15 | MIT | examples (dev) |
| typescript | 5.9.3 | Apache-2.0 | all (dev) |

To inspect full transitive dependency licenses, run `pnpm licenses list` in the repository root.
