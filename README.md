# On-Chain Behavior-Based Competency Certification — Evaluation Pipeline & Paper Experiments (Reproduction Package)

**Paper**: 제3자 재현 검증이 가능한 온체인 행위 기반 역량 인증 프레임워크
("A Third-Party Reproducible Framework for On-Chain Behavior-Based Competency Certification")

This repository is a **reproduction package**, not the full production system. It contains:

- The evaluation pipeline core used by the paper's experiments — `110 DomainAdapter → 120 Collection/normalize → 130 SessionConstructor → 140 FeatureExtractor → 150 Scorer → 160 session-root aggregation` (no issuance, burn, KMS signing, or validator-network code — those are operational concerns of the production system and out of scope here).
- **(added in v1.1.0)** The `EvaluationReport` v1 schema and builder, `reportHash` v1/v2 computation, a read-only credential verification tool, and local-fork scenario tests — see [Credential verification](#credential-verification-added-in-v110-after-the-paper-submission). These were added after the paper-submission snapshot (`v1.0.1-paper`) and do not affect any experiment result in the paper.
- The exact ruleSets used (`GENERIC-R1`, `SC-DEV-PRO-M1`).
- The experiment scripts referenced in the paper:
  - **Exp.1** — independent-RPC-provider reproducibility (same input → same `sessionRoot`/score across independently operated nodes), its chain-tip variant, and the input-completeness check (the determinism condition behind the paper's "0 silent mismatches, 4 UNVERIFIABLE" result)
  - **Exp.2** — on-chain gas cost (data only: the real tx-hash list + gas numbers; every hash is independently checkable on Polygonscan, no script needed to trust the numbers)
  - **Exp.3** — processing-time/latency measurement (single-session and multi-session variants)
  - **Exp.4** — inflation-resistance testing on a local Polygon mainnet fork (zero cost, full control)
- The frozen transaction-hash datasets Exp.1/Exp.2/Exp.3 were run against (all real, already-public Polygon mainnet transactions — nothing synthetic).
- The result CSVs reported in the paper.
- The deployed, verified contract source (`CompetencyAttestationSBTV4.sol`) for reference — provided as-is to match the verified on-chain bytecode; this repo does not include a build setup for it (its OpenZeppelin/local-interface imports are not bundled).

## What is explicitly NOT in this repository

This is a curated subset of a larger private system. Deliberately excluded:

- Issuance (`issue`), burn, KMS-signing, and validator-network SDK modules, and the backend — operational code for the live production deployment. (The fork test script signs test issuances with throwaway keys inside the script itself.)
- `.env` files, API keys, RPC URLs, AWS/KMS key IDs, custody-related code.
- Any issuance record naming a real person (examinee data) — including function-label strings that embedded a real name in the source project's internal gas-measurement script; the Exp.2 data here was regenerated with an anonymized label (`issueOrUpdate_mainnet_production_1`) referring to the same, already-public transaction hash.
- Operational documents (multisig SOPs, deployment runbooks, internal STATUS/progress notes) and any address other than the public contract/Safe signer addresses already visible on-chain.
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
  exp2-gas/                 Exp.2 — script that (re)builds exp2_gas.csv from the listed real tx hashes
  exp3-latency/             Exp.3 — processing-time measurement (single-session + multi-session variants)
  exp4-inflation/           Exp.4 — mission definition + local-fork inflation-resistance script
  results/                  CSV outputs reported in the paper
  results/raw/              frozen real-tx-hash datasets Exp.1/Exp.2/Exp.3 were run against
  verification/             read-only on-chain checks of the deployment facts quoted in the paper (added 2026-10-22)
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

## Experiment 2 (on-chain gas cost) — data only

No script to "run" in the reproducibility sense — `paper-experiments/results/exp2_gas.csv` lists
every transaction hash the paper's gas figures come from (contract deployment, setup, Safe
multisig, Timelock execution, 1 production issuance, 10 test issuances — see
`results/raw/exp2_mainnet_test_issuance_gas.json` for the latter). Every `tx_hash` is independently
checkable on [Polygonscan](https://polygonscan.com) — that's the point: no script needs to be
trusted, just the public chain. `exp2-gas/build-exp2-csv.mjs` regenerates the CSV from the same
hardcoded, already-public hash/gas values if you want to verify the USD conversion arithmetic.

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

## On-chain deployment facts (read-only verification, 2026-10-22)

The deployment details quoted in the paper were checked directly against Polygon PoS mainnet with
read-only calls (`eth_call`, `eth_getLogs`, `eth_getTransactionReceipt`, `eth_getCode`); no transaction
was sent. Machine-readable result: `paper-experiments/results/deployment_info.json`. Scripts:
`paper-experiments/verification/` (need an archive RPC; `getLogs` scans use `INFURA_POLYGON_RPC_URL`
because free Alchemy plans cap `getLogs` at 10 blocks).

| Item | On-chain value |
|---|---|
| SBT proxy | `0xb7e3B228308F97431de7d4d4b7690A35B23052Ba`, first block with code 89,346,326 |
| Implementation (EIP-1967 slot) | `0x52717cc53C420c44c7734918488b4EdAf2516073` |
| Proxy owner | the Timelock `0x51caF45eB42eb648dee04f24271134E7046eA2a4` |
| Timelock `getMinDelay()` | 86,400 s (24 h). PROPOSER and CANCELLER: the Safe. EXECUTOR: **open** (`address(0)` holds the role, so anyone can execute a matured operation) |
| Safe `0x2A04…0dF5` | threshold 2, 3 owners (owner addresses not published here) |
| ERC-5192 (`supportsInterface(0xb45a3c0e)`) | `true` |
| Validator registry | `0x07D7EB170964D555db1D270B2B7dDAc9A3C8fC67`, owned by the Timelock. **`threshold() = 2`** with 2 active validators since 2026-10-24 (block 96,066,937): both validators must sign to issue. The threshold was 1 until then (set at deployment); one validator was replaced in the same Timelock batch. Snapshot of 2026-10-22: `threshold() = 1`. |
| Approved rule sets | two `(missionId, ruleSetId)` pairs only (see `deployment_info.json`). **SC-DEV-PRO-M1 (`0xdb2378ff…3dc0`) has never been approved on-chain.** |

SC-DEV-PRO-M1's `ruleSetId` is derived from the canonical body in `rulesets/SC-DEV-PRO-M1.json`
(`node rulesets/build-sc-dev-pro-m1.mjs`, same procedure as `build-generic-r1.mjs`).

Revocation of the 10 Exp.2 test tokens (Timelock `scheduleBatch` → 24 h → `executeBatch`):
`results/exp2_revocation_gas.csv` (gas, price, POL cost per transaction) and
`results/exp2_revocation_token_state.csv` (all 10 tokens `revoked = true`, `ownerOf` reverts).
`results/exp2_extra_test_issuances.json` lists the 3 further mints that make the cumulative total 14
(1 production + 10 revoked tests + 3 mints on the ODA-BASIC mission; those 3 were unrevoked on 2026-10-22).

Operational change of 2026-10-24: one Timelock batch (`scheduleBatch` 2026-10-22 → 24 h → `executeBatch`
2026-10-24) replaced one validator, raised the registry threshold 1 → 2 and revoked those 3 ODA-BASIC
system-verification mints (reason `EXAM_REVOKED`). Receipts and post-state: `results/ops_threshold_and_revocation_2026-10.csv`,
`results/raw/onchain_verification_2026-10-24.json`; script: `paper-experiments/verification/verify-post-executebatch.mjs`.
Both transactions were submitted to the chain by a third-party relayer (gas not paid by the operator);
addresses are not published. Result: 13 of 14 minted tokens revoked, 1 valid (the production token).

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
- The default `--report-url` points to the operator's public report API. Until that API is enabled, pass
  `--report-file` or a `--mirror-url`.
- The applicant name is stored in plaintext on-chain by the deployed contract (v4); this is a property of the
  contract, not of the reports.

### Tests

```bash
cd sdk && npm run build && cd ..
node --test tests/evaluation-report.test.mjs      # hashing, determinism, validation, parity vector (no network)
```

Local-fork scenarios (nothing is sent to mainnet; needs [Foundry](https://getfoundry.sh) `anvil` and a Polygon
archive RPC to fork from; the fork block must be on or after 2026-10-24, when the validator threshold became 2):

```bash
anvil --fork-url <polygon-archive-rpc> --port 8548 --chain-id 137 --silent
node tools/e2e-evaluation-report-fork.mjs
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
production backend's tests are locked to.

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

## Verifying no secrets are present

Before any publish of this repository, run a secret scan and a real-name grep — see
`SECURITY_SCAN.md` for the commands and the report from the most recent scan.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for any noncommercial purpose (research, education,
personal/academic use included). Contact the authors for commercial licensing.
