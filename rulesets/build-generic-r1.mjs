#!/usr/bin/env node
/**
 * GENERIC-R1 ruleSet 생성 — 공개 지갑(무작위 DEX 유저) 대상 범용 ruleSet.
 *
 * 설계 근거: SC-DEV-PRO-M1은 특정 미션(constructor→setup→transferOwnership→schedule→execute)
 * 어휘에 의존하는 stateMachine + evidenceMapping을 갖고 있어, 무작위 공개 지갑(DEX 트레이더 등)에는
 * 전혀 맞지 않음.
 *
 * GENERIC-R1은 stateMachine과 evidenceMapping을 모두 생략한다. SDK의 5개 FeatureExtractor
 * (Efficiency/Stability/Coherence/RiskPattern/Excellence)는 base 알고리즘 자체가 이미
 * actionType 어휘가 아니라 status(success/fail)·timestamp·inputDigest만으로 계산되도록
 * 설계되어 있음(140+ 단계는 도메인 무관) — extract-helpers.ts의
 * applyAbsencePenalties/applyStepViolationsPenalty는 mapping/stateMachine이 없으면
 * 그대로 no-op 하도록 이미 구현되어 있어 코드 수정 없이 ruleSet 값만으로 범용화 가능함을
 * sdk/src/feature/extract-helpers.ts, sdk/src/feature/extractors/RiskPatternExtractor.ts에서 확인.
 *
 * 세션 구성: time-timeout만 사용(timeoutSeconds=1800).
 * featureWeights: 5개 균등(0.2) — 특정 도메인에 유리하게 치우치지 않도록.
 * issuerSet: 0x0 placeholder — 이 ruleSet은 실험 전용이며 실제 발급에 쓰이지 않음.
 *
 * 실행하면 ruleSetId를 재계산해 GENERIC-R1.json과 바이트 단위로 동일한지(=canonicalSerialize
 * 결정성) 직접 검증할 수 있다: `node rulesets/build-generic-r1.mjs` 후 diff.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRuleSetId } from "../sdk/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = HERE;
mkdirSync(OUT_DIR, { recursive: true });

const ruleSetBody = {
  version: "1.0.0",
  missionId: "GENERIC-R1",
  trackId: "paper-experiment-reproducibility",
  chainScope: [137],
  validFrom: 1735689600, // 2025-01-01T00:00:00Z — 실험용 고정값, 실제 발급 유효기간 아님
  gradeThresholds: { basic: 50, associate: 75, professional: 90 },
  featureWeights: {
    efficiency: 0.2,
    stability: 0.2,
    coherence: 0.2,
    riskPattern: 0.2,
    excellence: 0.2,
  },
  sessionBoundaryRule: {
    timeoutSeconds: 1800,
    // boundaryActionTypes / minActionCount / stateMachine / similarityRule 전부 생략 (순수 time-timeout)
  },
  // evidenceMapping 생략 — absencePenalty/evidenceMapping 기반 보정 전부 no-op
  issuerSet: ["0x0000000000000000000000000000000000000000"],
};

const ruleSetId = computeRuleSetId(ruleSetBody);

const output = {
  _comment:
    "GENERIC-R1 — 논문 실험 1/3/4 전용 범용 ruleSet. 실제 SBT 발급에 사용되지 않음(issuerSet=0x0 placeholder). SC-DEV-PRO-M1의 미션 특화 stateMachine/evidenceMapping을 생략해 도메인 무관 5특성 base 알고리즘만으로 채점.",
  ruleSetId,
  ruleSetBody,
};

const outPath = resolve(OUT_DIR, "GENERIC-R1.json");
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`ruleSetId = ${ruleSetId}`);
console.log(`저장: ${outPath}`);
