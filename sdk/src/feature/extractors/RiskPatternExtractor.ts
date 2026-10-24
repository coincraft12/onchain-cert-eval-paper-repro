/**
 * 144 RiskPattern — 리스크 회피 (연속 실패·급한 재시도 없음이 높은 값).
 *
 * 알고리즘 (도메인 무관):
 *   value = 1 - (consecutiveFailRate + rapidRetryRate) / 2
 *   - consecutiveFailRate = fail→fail 시퀀스 수 / (n-1)
 *   - rapidRetryRate = 같은 actionType 이 실패 후 짧은 간격 재시도된 수 / (n-1)
 *     짧은 간격 = RAPID_THRESHOLD_SECONDS (기본 5초) 이하
 *
 * evidence: 연속 실패 · 급한 재시도 각각.
 */

import { applyEvidenceMapping, clamp01 } from "../extract-helpers.js";
import type {
  EvidencePointer,
  ExtractFeaturesParams,
  FeatureExtractionResult,
} from "../types.js";

const RAPID_THRESHOLD_SECONDS = 5;

export function extractRiskPattern(
  params: ExtractFeaturesParams,
): FeatureExtractionResult {
  const { session } = params;
  const n = session.actions.length;
  const evidence: EvidencePointer[] = [];
  if (n === 0) return { value: 1, evidence: [] }; // 액션 없음 = 리스크 최소

  if (n === 1) {
    applyEvidenceMapping(session, params.evidenceMapping, "riskPattern", evidence);
    return { value: 1, evidence }; // 단일 액션은 리스크 관측 어려움
  }

  let consecutiveFails = 0;
  let rapidRetries = 0;
  for (let i = 1; i < n; i++) {
    const prev = session.actions[i - 1]!;
    const cur = session.actions[i]!;
    if (prev.status === "fail" && cur.status === "fail") {
      consecutiveFails += 1;
      evidence.push({
        feature: "riskPattern",
        sessionId: session.sessionId,
        actionIndex: i,
        actionId: cur.actionId,
        weight: -1 / n,
        reason: "consecutive-fail",
      });
    }
    if (
      prev.actionType === cur.actionType &&
      prev.status === "fail" &&
      cur.timestamp - prev.timestamp < RAPID_THRESHOLD_SECONDS
    ) {
      rapidRetries += 1;
      evidence.push({
        feature: "riskPattern",
        sessionId: session.sessionId,
        actionIndex: i,
        actionId: cur.actionId,
        weight: -1 / n,
        reason: "rapid-retry",
      });
    }
  }

  const denom = n - 1;
  const conseqRate = consecutiveFails / denom;
  const rapidRate = rapidRetries / denom;
  const riskScore = (conseqRate + rapidRate) / 2;
  const value = clamp01(1 - riskScore);

  applyEvidenceMapping(session, params.evidenceMapping, "riskPattern", evidence);
  return { value, evidence };
}
