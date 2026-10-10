/**
 * 141 Efficiency — 목표 달성 효율.
 *
 * 알고리즘 (도메인 무관):
 *   value = successRate - duplicateInputPenalty
 *   - successRate = successful_actions / total_actions
 *   - duplicateInputPenalty = 중복 inputDigest 초과분 / total_actions
 *     (같은 입력 여러 번 = 낭비된 시도)
 *
 * evidence: 성공 액션 각각 + evidenceMapping 규칙 매칭.
 */

import { applyEvidenceMapping, clamp01 } from "../extract-helpers.js";
import type {
  EvidencePointer,
  ExtractFeaturesParams,
  FeatureExtractionResult,
} from "../types.js";

export function extractEfficiency(
  params: ExtractFeaturesParams,
): FeatureExtractionResult {
  const { session } = params;
  const n = session.actions.length;
  if (n === 0) return { value: 0, evidence: [] };

  const successCount = session.actions.filter((a) => a.status === "success").length;
  const successRate = successCount / n;

  // 중복 inputDigest 페널티
  const digestCounts = new Map<string, number>();
  for (const a of session.actions) {
    if (a.inputDigest !== undefined) {
      digestCounts.set(a.inputDigest, (digestCounts.get(a.inputDigest) ?? 0) + 1);
    }
  }
  let duplicates = 0;
  for (const c of digestCounts.values()) if (c > 1) duplicates += c - 1;
  const dupPenalty = duplicates / n;

  const value = clamp01(successRate - dupPenalty);

  const evidence: EvidencePointer[] = [];
  session.actions.forEach((a, idx) => {
    if (a.status === "success") {
      evidence.push({
        feature: "efficiency",
        sessionId: session.sessionId,
        actionIndex: idx,
        actionId: a.actionId,
        weight: 1 / n,
        reason: "success",
      });
    }
  });
  applyEvidenceMapping(session, params.evidenceMapping, "efficiency", evidence);

  return { value, evidence };
}
