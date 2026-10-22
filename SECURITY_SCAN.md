# Pre-publish security scan (run before any public release)

Last run: 2026-10-10, after adding Exp.1 chain-tip/input-completeness results and Exp.2 gas data
(paper-session review requested these be included; see commit history).
Scope: this repository's working tree, exactly as staged for commit (no `node_modules`, no
`sdk/dist`, no `.env` — all excluded by `.gitignore`).

## 1. Secret scan — gitleaks v8.30.1

```
gitleaks detect --source . --no-git -v
gitleaks detect --source . -v        # git-history mode, same result
```

Result: **3 findings, all the same confirmed false positive.** The string `wallet2_411f5007`
(a dataset label key, flagged purely for entropy) appears in the script that defines it, in its own
generated output JSON, and — recursively — in this report describing the finding. No real secret
anywhere.

| File | Rule | Flagged string | Verdict |
|---|---|---|---|
| `paper-experiments/exp3-latency/run-exp3b-latency-multisession.mjs` | `generic-api-key` (entropy 3.625) | `wallet2_411f5007` | **False positive** — dataset label key (`{ key: "wallet2_411f5007", address: "0x411f...", ... }`), not a credential. The `address` field is the public Polygon wallet address used as Exp.3's multi-session test input (see README) — publishing it is the point of the experiment. |
| `paper-experiments/results/raw/exp3b_latency_multisession_raw.json` | `generic-api-key` | `wallet2_411f5007` | Same string, carried into the script's own output. Same verdict. |
| `SECURITY_SCAN.md` | `generic-api-key` | `wallet2_411f5007` | Recursive match on this report quoting the string. Same verdict. |

Supplementary targeted greps — zero matches for all of: UUID-shaped strings (KMS key IDs),
`privateKey`/`mnemonic`/`seedPhrase` field names, AWS `AKIA...` access-key prefix.

## 2. Real-name / PII grep

```
grep -rn "김응준" .                                                           # see below
grep -rinE "kim[ _-]?eung[ _-]?jun|eung[ _-]?jun[ _-]?kim" .                   # see below — caught a real finding
grep -rEn "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}" .                   # 0 matches
grep -rEn "01[0-9]-?[0-9]{3,4}-?[0-9]{4}" .                                    # see below
grep -rin "Sharon|coincraft\.edu|신윤정|류재철" .                              # 0 matches outside this report's own grep commands
```

- **실명(real name) "김응준"**: 0 matches in actual content. The production issuance that used this
  name (`issuance/`, `paper-experiments/results/raw/e2e_kim_eunjun_*`) was excluded from this
  repository entirely, per scope.
- **Romanized variant "kimeungjun" — ⚠️ caught and fixed.** The source project's internal
  `paper-experiments/exp2-gas/build-exp2-csv.mjs` embeds the real name in a function-label string
  (`issueOrUpdate_mainnet_#1_kimeungjun`) and an internal comment (`실발급 #1 (김응준 본인, ...)`).
  This script was **not copied** into this repository. Instead, `exp2_gas.csv` and
  `exp2-gas/build-exp2-csv.mjs` here were rewritten from scratch with every value byte-identical
  except the one label, anonymized to `issueOrUpdate_mainnet_production_1` — the underlying
  transaction hash (`0x92288640...`, independently checkable on Polygonscan) is unchanged; only the
  human-readable label that happened to embed a name was changed. Re-grepped after the rewrite:
  0 matches for `kimeungjun` or `김응준` anywhere in the tracked tree.
- **Email addresses**: 0 matches.
- **Phone-number-shaped strings**: matches only inside the frozen raw transaction-hash JSON files
  (`exp1_router_txlist_raw.json`, `exp1_wallet_txlists.json`, `exp1b_chaintip_wallets.json`,
  `exp3b_wallet*_txlist_raw.json`) — every hit is a substring of a `0x...` hash/address (hex noise
  coincidentally matching the digit-grouping pattern), not an actual phone number. Confirmed by
  inspecting the matched files directly.
- **Other names** (Sharon, coincraft.edu, other co-authors/operators from the private project):
  0 matches outside this report's own description of the grep commands run.

## 3. Intentional, expected occurrences (not leaks)

- `LICENSE` contains a `Required Notice: Copyright CoinCraft (Kim Eung-jun)` line — this is the
  license's own required copyright-attribution notice (standard for a published open-source
  license, and the paper's actual author), not an incidental leak of examinee data. This is the
  one place a name is expected to appear.
- `rulesets/SC-DEV-PRO-M1-ruleset.json` includes a public Ethereum address
  (`0x402a8ec6e432ef3293d88cee5d886335689f7a3f`) in `issuerSet` — a public on-chain address from an
  already-rotated/retired key (superseded 2026-10-08), not a secret.
- `contracts/CompetencyAttestationSBTV4.sol` contains the literal string `"CoinCraftCompetencyAttestation"`
  as the on-chain EIP-712 domain name — already public on Polygonscan as part of the verified,
  deployed contract source.
- `paper-experiments/results/exp2_gas.csv` and `results/raw/exp2_mainnet_test_issuance_gas.json`
  list real Polygon mainnet transaction hashes and gas numbers by design (Exp.2's entire point is
  "anyone can independently check these on Polygonscan") — publishing them is intentional, not a
  leak.

## Conclusion

No secrets, credentials, API keys, RPC URLs with embedded keys, KMS key IDs, or AWS configuration
were found. One real-name leak vector was found during this process (a romanized name embedded in
an internal script that was a candidate for inclusion) and was fixed by excluding that script and
shipping a rewritten, anonymized equivalent instead — not merely redacting, but confirming the
replacement script and its output verify byte-identical elsewhere. Re-scanned clean after the fix.
The repository is clear to publish as far as this scan can determine.

---

## Addendum — 2026-10-22 (on-chain verification files added)

Scope: files added/changed in this commit only (`paper-experiments/verification/`, new files under
`paper-experiments/results/` and `results/raw/`, `rulesets/SC-DEV-PRO-M1.json`, `rulesets/build-sc-dev-pro-m1.mjs`,
`README.md`, `exp4-inflation/mission-definition.md`).

- **gitleaks: not run for this addendum** — the binary was not available on the machine used. Replaced by the
  manual checks below; re-run gitleaks before the next release if possible.
- Manual checks, all clean:
  - RPC URL / provider-key patterns (`alchemy.com/v2/<key>`, `infura.io/v3/<key>`, dRPC, PublicNode): 0 matches
    (only the pre-existing `YOUR_KEY` placeholder in README).
  - `privateKey|mnemonic|seedPhrase|AKIA…`, `kms`, real-name romanizations, `sharon`, `coincraft.edu`, `@gmail`: 0 matches
    in new files (README's existing statements that KMS/issuance code is *excluded* are unchanged).
  - High-entropy string scan (strings ≥32 chars that are not `0x` hashes/addresses or decimal token ids): only file-path strings.
- Deliberately **not** published: Safe owner addresses (count and threshold only), validator addresses and `nodeId`
  strings, transaction sender (`from`) addresses, user addresses of the 3 extra mints.
- Everything in `deployment_info.json` and the new CSV/JSON files is public on-chain data (contract addresses,
  tx hashes, blocks, gas).
