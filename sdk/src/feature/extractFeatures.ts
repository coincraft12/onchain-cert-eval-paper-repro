/**
 * FeatureExtractor 오케스트레이터 (140).
 *
 * 5 extractor 를 순차 실행 후 FeatureVector 로 조립.
 * 각 extractor 는 독립적이고 결정적 — 같은 세션 입력 → 같은 결과.
 */

import {
  applyAbsencePenalties,
  applyHumanPacePenalty,
  applyStepViolationsPenalty,
  applyTerminalReachedBonus,
} from "./extract-helpers.js";
import { extractCoherence } from "./extractors/CoherenceExtractor.js";
import { extractEfficiency } from "./extractors/EfficiencyExtractor.js";
import { extractExcellence } from "./extractors/ExcellenceExtractor.js";
import { extractRiskPattern } from "./extractors/RiskPatternExtractor.js";
import { extractStability } from "./extractors/StabilityExtractor.js";
import type { ExtractFeaturesParams, FeatureVector } from "./types.js";

export function extractFeatures(params: ExtractFeaturesParams): FeatureVector {
  const eff = extractEfficiency(params);
  const stab = extractStability(params);
  const coh = extractCoherence(params);
  const risk = extractRiskPattern(params);
  const exc = extractExcellence(params);

  // Cross-cutting 페널티·보너스 순차 적용:
  //   1) absencePenalty (evidenceMapping 기반 · 누락된 액션)
  //   2) stepViolationsPenalty (state machine 위반)
  //   3) terminalReachedBonus (state machine 완주 시 상승)
  //   4) humanPacePenalty (bot 감지 · 마지막에 적용 — multiplicative)
  const { values: afterAbsence, evidence: absenceEvidence } = applyAbsencePenalties(
    params.session,
    params.evidenceMapping,
    {
      efficiency: eff.value,
      stability: stab.value,
      coherence: coh.value,
      riskPattern: risk.value,
      excellence: exc.value,
    },
  );
  const { values: afterViolations, evidence: violationEvidence } =
    applyStepViolationsPenalty(params.session, afterAbsence);
  const { values: afterTerminal, evidence: terminalEvidence } =
    applyTerminalReachedBonus(params.session, afterViolations);
  const { values: adjusted, evidence: paceEvidence } =
    applyHumanPacePenalty(params.session, afterTerminal);

  return {
    ...adjusted,
    evidence: [
      ...eff.evidence,
      ...stab.evidence,
      ...coh.evidence,
      ...risk.evidence,
      ...exc.evidence,
      ...absenceEvidence,
      ...violationEvidence,
      ...terminalEvidence,
      ...paceEvidence,
    ],
  };
}
