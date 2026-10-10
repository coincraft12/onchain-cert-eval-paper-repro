# Pre-publish security scan (run before any public release)

Date: 2026-10-10
Scope: this repository's working tree, exactly as staged for the first commit (no `node_modules`,
no `sdk/dist`, no `.env` — all excluded by `.gitignore`).

## 1. Secret scan — gitleaks v8.30.1

```
gitleaks detect --source . --no-git -v
```

Result: **3 findings, all the same confirmed false positive** (the string `wallet2_411f5007` appears
in the script, in its generated output, and — recursively — in this report's own description of the
finding).

| File | Line | Rule | Flagged string | Verdict |
|---|---|---|---|---|
| `paper-experiments/exp3-latency/run-exp3b-latency-multisession.mjs` | 31 | `generic-api-key` (entropy 3.625) | `wallet2_411f5007` | **False positive** — this is a dataset label key (`{ key: "wallet2_411f5007", address: "0x411f...", ... }`), not a credential. The adjacent `address` field is a public Polygon wallet address used as Exp.3's multi-session test input (see README) — publishing it is the point of the experiment (third-party reproducibility against real public chain data), not a leak. |
| `paper-experiments/results/raw/exp3b_latency_multisession_raw.json` | 13 | `generic-api-key` | `wallet2_411f5007` | Same string, carried into the script's own output file. Same verdict. |
| `SECURITY_SCAN.md` | (this file, describing the finding above) | `generic-api-key` | `wallet2_411f5007` | Recursive match on this report quoting the string. Same verdict. |

No AWS keys, API keys, private keys, or KMS key IDs (UUID-shaped strings) were found anywhere in the
tracked tree. Supplementary targeted greps (UUID pattern, `privateKey`/`mnemonic`/`seedPhrase` field
names, AWS `AKIA...` access-key prefix) returned zero matches.

## 2. Real-name / PII grep

```
grep -rn "김응준" .                                                    # 0 matches
grep -rEn "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}" .            # 0 matches (no email addresses)
grep -rEn "01[0-9]-?[0-9]{3,4}-?[0-9]{4}" .                              # see below
grep -rn "신윤정\|류재철\|Sharon\|eungjun\|eungjungkim\|coincraft.edu" .  # 0 matches
```

- **실명(real name) "김응준"**: 0 matches. The production issuance that used this name
  (`issuance/`, `paper-experiments/results/raw/e2e_kim_eunjun_*`) was excluded from this repository
  entirely, per scope.
- **Email addresses**: 0 matches.
- **Phone-number-shaped strings**: the regex matched only inside the frozen raw transaction-hash
  JSON files (`paper-experiments/results/raw/exp1_router_txlist_raw.json`,
  `exp1_wallet_txlists.json`, `exp1b_chaintip_wallets.json`, `exp3b_wallet*_txlist_raw.json`) —
  every hit is a substring of a `0x...` transaction hash or address (64-hex blobs coincidentally
  matching the loose digit-grouping pattern), not an actual phone number. Confirmed by inspecting
  the matched files directly.
- **Other names checked** (co-author, examinee, operator names appearing elsewhere in the private
  project): 0 matches.

## 3. Intentional, expected occurrences (not leaks)

- `LICENSE` contains a `Required Notice: Copyright CoinCraft (Kim Eung-jun)` line — this is the
  license's own required copyright-attribution notice (standard for a published open-source
  license), not an incidental leak of issuance/examinee data.
- `rulesets/SC-DEV-PRO-M1-ruleset.json` includes a public Ethereum address
  (`0x402a8ec6e432ef3293d88cee5d886335689f7a3f`) in `issuerSet` — this is a public on-chain address
  from an already-rotated/retired key (superseded 2026-10-08), not a secret.
- `contracts/CompetencyAttestationSBTV4.sol` contains the literal string `"CoinCraftCompetencyAttestation"`
  as the on-chain EIP-712 domain name — already public on Polygonscan as part of the verified,
  deployed contract source.

## Conclusion

No secrets, credentials, API keys, RPC URLs with embedded keys, KMS key IDs, AWS configuration, or
real-person PII were found in the tracked tree. The repository is clear to publish as far as this
scan can determine.
