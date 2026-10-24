# Evaluation Pipeline & Paper Experiments (Reproduction Package) — anonymized review branch

> **Anonymized branch for double-blind review.** Author names, organization names, the paper title, DOIs and on-chain transaction identifiers have been removed. On-chain transaction identifiers (transaction hashes, block numbers, contract/multisig/timelock/validator addresses, token ids) will be published after acceptance. Aggregate gas/cost figures are in `paper-experiments/results/exp2_cost_summary_anon.json`.

This repository is a **reproduction package**, not the full production system. It contains:

- The evaluation pipeline core used by the paper's experiments — `110 DomainAdapter → 120 Collection/normalize → 130 SessionConstructor → 140 FeatureExtractor → 150 Scorer → 160 session-root aggregation` (no issuance, burn, KMS signing, or validator-network code — those are operational concerns of the production system and out of scope here).
- **(added in v1.1.0)** The `EvaluationReport` v1 schema and builder, `reportHash` v1/v2 computation, a read-only credential verification tool, and local-fork scenario tests — see [Credential verification](#credential-verification-added-in-v110-after-the-paper-submission). These were added after the paper-submission snapshot (`v1.0.1-paper`) and do not affect any experiment result in the paper.
- The exact ruleSets used (`GENERIC-R1`, `SC-DEV-PRO-M1`).
- The experiment scripts referenced in the paper:
  - **Exp.1** — independent-RPC-provider reproducibility (same input → same `sessionRoot`/score across independently operated nodes), its chain-tip variant, and the input-completeness check (the determinism condition behind the paper's "0 silent mismatches, 4 UNVERIFIABLE" result)
  - **Exp.2** — on-chain gas cost (aggregate figures only on this branch: gas used, gas price, cost; transaction identifiers are withheld until acceptance)
  - **Exp.3** — processing-time/latency measurement (single-session and multi-session variants)
  - **Exp.4** — inflation-resistance testing on a local Polygon mainnet fork (zero cost, full control)
- The frozen transaction-hash datasets Exp.1/Exp.3 were run against (all real, already-public Polygon mainnet transactions — nothing synthetic).
- The result CSVs reported in the paper.
- The deployed, verified contract source (`CompetencyAttestationSBTV4.sol`) for reference — provided as-is to match the verified on-chain bytecode; this repo does not include a build setup for it (its OpenZeppelin/local-interface imports are not bundled).

## What is explicitly NOT in this repository

This is a curated subset of a larger private system. Deliberately excluded:

- Issuance (`issue`), burn, KMS-signing, and validator-network SDK modules, and the backend — operational code for the live production deployment. (The fork test script signs test issuances with throwaway keys inside the script itself.)
- `.env` files, API keys, RPC URLs, AWS/KMS key IDs, custody-related code.
- Any issuance record naming a real person (examinee data).
- Operational documents (multisig SOPs, deployment runbooks, internal STATUS/progress notes) and, on this review branch, all deployment-specific on-chain identifiers.
- Test-wallet private keys (none of the experiments ever need one — Exp.4 uses Anvil's `anvil_impersonateAccount` cheat code on a local fork, not a real signed transaction).

## Repository layout

```
sdk/                        evaluation pipeline core (TypeScript, builds to sdk/dist); report/ holds EvaluationReport + reportHash v1/v2
tools/                      verify-credential.mjs (read-only verifier), e2e-evaluation-report-fork.mjs (local-fork scenarios A–F)
tests/                      node:test unit tests for the report code (no network)
rulesets/                   GENERIC-R1.json, SC-DEV-PRO-M1-ruleset.json (+ canonical body/ruleSetId in SC-DEV-PRO-M1.json), and the scripts that derive both ruleSetIds
contracts/                  CompetencyAttestationSBTV4.sol (reference only, matches verified on-chain source)
paper-experiments/
  exp1-rpc-providers/       Exp.1 — independent-RPC reproducibility + chain-tip variant + input-completeness check
  exp3-latency/             Exp.3 — processing-time measurement (single-session + multi-session variants)
  exp4-inflation/           Exp.4 — mission definition + local-fork inflation-resistance script
  results/                  CSV outputs reported in the paper
  results/raw/              frozen real-tx-hash datasets Exp.1/Exp.3 were run against
  verification/             build-exp1c-tx-age.mjs (Exp.1 transaction-age table)
```

## Install

Requires Node.js >= 20.

```bash
# 1. build the evaluation pipeline core
cd sdk && npm install && npm run build && cd ..

# 2. install dependencies for the experiment scripts (repo root)
npm install

# 3. copy the env template and fill in your own free-tier RPC/API keys
cp paper-experiments/.env.example paper-experiments/.env
# edit paper-experiments/.env — see "API keys you need" below
```

## Reproduce Experiment 1 (independent-RPC reproducibility)

This is the paper's core reproducibility claim: the same frozen set of real transaction hashes
(`paper-experiments/results/raw/exp1_wallet_txlists.json`), fetched independently from two or more
RPC providers operated by different companies, must normalize/session/score to the **exact same
`sessionRoot` and score** — because the pipeline is deterministic by construction (fixed reference
block, fixed ruleSet, canonical serialization; see `sdk/src/canonical/serialize.ts` and
`sdk/src/session/SessionConstructor.ts`).

```bash
node paper-experiments/exp1-rpc-providers/run-exp1.mjs
```

This re-fetches all transactions in the frozen hash list from each RPC provider in your `.env`,
runs the evaluation pipeline independently per provider, and writes a fresh
`paper-experiments/results/exp1_reproducibility.csv` — a `match` column of `1` for every row (every
RPC pair × every wallet) is the reproducibility claim being verified, byte-for-byte, by you, on your
own RPC accounts.

Other Exp.1 variants:

```bash
# chain-tip variant — live, freshly collected wallets/TXs (not the frozen dataset); needs ETHERSCAN_API_KEY
# the measured results reported in the paper (25 wallets, condA/condB stability, RPC-pair match
# counts) are shipped as-is in results/exp1b_chaintip.csv + results/raw/exp1b_chaintip_summary.json —
# a fresh run will fetch the current chain tip and so will not reproduce the exact same numbers
# (chain state keeps moving forward; the paper is explicit about this), only the same methodology.
node paper-experiments/exp1-rpc-providers/run-exp1-chaintip.mjs

# input-completeness check — this is the determinism condition behind the paper's reported
# "21 MATCH / 4 UNVERIFIABLE / 0 silent mismatches" (results/exp1c_integrity_check.csv). It reuses
# the frozen paper-experiments/results/raw/exp1b_chaintip_wallets.json shipped in this repo, so it
# runs standalone without needing run-exp1-chaintip.mjs first.
node paper-experiments/exp1-rpc-providers/run-exp1-integrity-check.mjs
```

## Experiment 2 (on-chain gas cost) — aggregate data only

`paper-experiments/results/exp2_cost_summary_anon.json` lists the gas used, gas price and cost of every
deployment/setup transaction, the 10 test issuances, and the governance transactions behind the
paper's cost figures. Transaction hashes, block numbers, addresses and token ids are intentionally omitted on this
review branch; they will be published after acceptance so that every figure can be checked against the public chain.

## Reproduce Experiment 3 (processing-time latency)

Pure local computation — no network calls, reuses the frozen `exp1_router_txlist_raw.json` dataset
(1000 real mainnet transactions).

```bash
node paper-experiments/exp3-latency/run-exp3-latency.mjs
```

```bash
# multi-session variant — reuses two real public wallets' full multi-month transaction history
# (also frozen/shipped in results/raw/) to measure latency when input spans many sessions
node paper-experiments/exp3-latency/run-exp3b-latency-multisession.mjs
```

## Reproduce Experiment 4 (inflation resistance, local fork)

Zero cost — runs entirely on a local Polygon-mainnet fork (`anvil`, part of [Foundry](https://getfoundry.sh)).
No real transactions are ever broadcast to mainnet.

```bash
# terminal 1 — start the fork (use any Polygon RPC URL, e.g. your ALCHEMY_POLYGON_RPC_URL)
anvil --fork-url https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY --port 8546 --chain-id 137

# terminal 2
node paper-experiments/exp4-inflation/run-exp4-inflation-fork.mjs
```

Mission definition and methodology: `paper-experiments/exp4-inflation/mission-definition.md`.

## On-chain deployment facts

The deployment facts quoted in the paper were checked against Polygon PoS mainnet with read-only calls; no
transaction was sent. The machine-readable result files and the scripts that produce them contain deployment-specific
identifiers and are withheld on this review branch until acceptance. Facts that do not identify the deployment:
the Timelock minimum delay is 86,400 s (24 h); the Timelock's EXECUTOR role is open (anyone can execute a matured
operation); the multisig threshold is 2 of 3; the contract supports ERC-5192; the validator registry threshold is 2
with 2 active validators since 2026-10-24; the `SC-DEV-PRO-M1` rule set was never approved on-chain.

`SC-DEV-PRO-M1`'s `ruleSetId` is derived from the canonical body in `rulesets/SC-DEV-PRO-M1.json`
(`node rulesets/build-sc-dev-pro-m1.mjs`, same procedure as `build-generic-r1.mjs`).

Exp.1 chain-tip ages: `results/exp1c_tx_age.csv` / `exp1c_tx_age_summary.json` give each transaction's
actual block timestamp and its age at the chain-tip observation time, next to the age that results from
assuming a 2.0 s block time (`age_days_if_2s_blocks`).

## Credential verification (added in v1.1.0, after the paper submission)

> This section describes functionality added **after** the paper-submission snapshot (`v1.0.1-paper`). It does not
> affect any experiment result in the paper; Exp.1–4 are unchanged.

A third party can check, read-only, what an on-chain SBT's `reportHash` points to, and whether the off-chain
evaluation report behind it reproduces.

### What is committed on-chain

The contract treats `reportHash` as an opaque `bytes32`.

| Scheme | Definition | Notes |
|---|---|---|
| **v1** | `keccak256(abi.encode(12 fields))` — userAddress, missionId, score, grade, ruleSetId, sessionRoot, nonce, expiry, timestamp, applicantName, courseId, issuerAddress | Used by Path B and by earlier issuances. A v1 hash commits to no input list, so the evaluation cannot be re-derived from it. |
| **v2** | `keccak256(abi.encode(the same 12 fields, bytes32 evaluationReportHash))` | `evaluationReportHash = keccak256(utf8(canonicalSerialize(EvaluationReport)))`. |

`EvaluationReport` (`sdk/src/report/evaluation.ts`, version `evaluation-report/1`) records the reference block
(number and hash), the evaluation window (`windowStart`/`windowEnd`), the mission scope (actor, target contracts,
whether failed transactions count), the ordered list of included transaction hashes with the action type used for
each (`txActionTypes`, needed because an action type may come from an explorer's function name and not be derivable
from calldata alone), the per-session roots and feature values, the score and grade, and the evaluator code version
(commit; a dirty tree is refused). `missionRef` is the human-readable mission label used by the ruleSet. It
deliberately contains **no personal data**: no applicant name, no name hash, no e-mail, no internal IDs.

### Verify a token

```bash
cd sdk && npm install && npm run build && cd ..
node tools/verify-credential.mjs <tokenId> \
  --contract <deployed-contract-address>   # or VERIFY_CONTRACT; there is no default on this branch
  --rpc <polygon-archive-rpc> [--rpc <second-provider-rpc> ...] \
  --report-file <envelope.json>          # or --mirror-url <base> / --report-url <base>
  --history rpc-scan                     # independent full-history source (see Limits)
```

The ruleSet body is looked up by `ruleSetId` in `rulesets/` (use `--ruleset-dir` for others). `VERIFY_RPCS`
(comma-separated) can replace `--rpc`. RPC URLs are never printed. Exit code: `0` MATCH, `2` MISMATCH,
`3` UNVERIFIABLE, `1` execution error. Add `--json` for machine-readable output.

### Verdicts

Precedence is MISMATCH > UNVERIFIABLE > MATCH. Every verdict is printed with its reasons.

| Verdict | Reason | Meaning (examples) |
|---|---|---|
| **MISMATCH** | value mismatch (값 불일치) | a recomputed value differs from the committed one: `evaluationReportHash`, v2 `reportHash` vs on-chain, block hash, a transaction outside the window or sent by someone else, recomputed sessions/features/score differ |
| **MISMATCH** | omission detected (누락 탐지) | a transaction that belongs to the mission scope appears in the independent history for `[windowStart, reference block]` but not in `includedTxHashes`; the missing hashes are printed |
| **UNVERIFIABLE** | lookup failed (조회 실패) | something needed could not be fetched or is not supported: a listed transaction the RPCs do not return, RPCs disagreeing, no stored report, rule set body not found, v1 hash (no report exists), or no independent history source |
| **MATCH** | — | all checks passed **and** an independent source covered the whole window |

Input *completeness* ("no transaction was left out") cannot be proven by a hash. It is judged only when an
independent history source returns the full history for the window; otherwise the result is UNVERIFIABLE, never
MATCH.

### Limits

- **RPC block scan: 20,000 blocks.** `--history rpc-scan` scans the evaluation window block by block and stops at a
  default cap of 20,000 blocks (`--history-scan-limit`). A longer window needs an indexer API.
- **Etherscan-compatible history (`--history etherscan`) is untested.** It was implemented but never run against a
  real endpoint because no API key was available when this was written; treat it as unverified.
- Reproduction supports the **normal-transaction pipeline** only (internal and token-transfer derived actions make
  the result UNVERIFIABLE).
- A v1 credential (including the first production issuance) is always UNVERIFIABLE (`legacy-v1`): the data needed
  to re-derive it was never committed.
- There is no default report source on this branch. Pass `--report-file`, `--report-url` or `--mirror-url`; without one the result is UNVERIFIABLE.
- The applicant name is stored in plaintext on-chain by the deployed contract (v4); this is a property of the
  contract, not of the reports.

### Tests

```bash
cd sdk && npm run build && cd ..
node --test tests/evaluation-report.test.mjs      # hashing, determinism, validation, parity vector (no network)
```

Local-fork scenarios (nothing is sent to mainnet; needs [Foundry](https://getfoundry.sh) `anvil` and a Polygon
archive RPC to fork from; the fork block must be on or after 2026-10-24, when the validator threshold became 2; the deployed
contract/registry/timelock addresses are passed as `E2E_SBT`, `E2E_REGISTRY`, `E2E_TIMELOCK`):

```bash
anvil --fork-url <polygon-archive-rpc> --port 8548 --chain-id 137 --silent
E2E_SBT=0x... E2E_REGISTRY=0x... E2E_TIMELOCK=0x... node tools/e2e-evaluation-report-fork.mjs
```

| | Scenario | Expected |
|---|---|---|
| A | normal v2 issuance on the fork | MATCH |
| B | evaluator drops an unfavorable (failed) transaction from the list | MISMATCH (omission detected, missing hash printed) |
| C | stored JSON altered (one input removed) | MISMATCH (value mismatch) |
| D | one listed transaction withheld by the RPC | UNVERIFIABLE (lookup failed) |
| E | no independent history source given | UNVERIFIABLE, no MISMATCH |
| F | v1 (12-field) issuance | UNVERIFIABLE (`legacy-v1`) |

The scenarios pass `--issue-tx` so the verifier does not scan logs against the forked upstream node (a log scan over a forked range is slow or rate-limited on free RPC plans). The script signs fork-only test issuances with throwaway keys generated at run time and impersonates the Timelock
only on the local fork. The parity vector `sdk/test/fixtures/evaluation-report-vector.json` is the same vector the
production backend's tests are locked to (it is hash-locked, so its contents are unchanged).

## API keys you need (all free tier)

| Variable | Where to get it | Needed for |
|---|---|---|
| `ALCHEMY_POLYGON_RPC_URL` | https://www.alchemy.com (free signup) | Exp.1, Exp.4 (fork source) |
| `PUBLICNODE_POLYGON_RPC_URL` | none — public endpoint, no key | Exp.1 |
| `INFURA_POLYGON_RPC_URL` | https://www.infura.io (free signup) | Exp.1 (optional, 3-way) |
| `DRPC_POLYGON_RPC_URL` | none — public endpoint, no key | Exp.1 (optional, 3-way) |
| `ETHERSCAN_API_KEY` | https://etherscan.io/apis (free signup, multichain V2 key) | Exp.1 chain-tip variant |
| Foundry (`anvil`) | https://getfoundry.sh (free, local install) | Exp.4 |

Exp.1's main script (`run-exp1.mjs`) needs at least **two** RPC providers from different operators;
`EXP1_EXCLUDE_PROVIDERS` (comma-separated provider keys) lets you adjust which ones are active to
match whatever keys you have.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for any noncommercial purpose (research, education,
personal/academic use included). Contact the authors (via the program committee) for commercial licensing.
