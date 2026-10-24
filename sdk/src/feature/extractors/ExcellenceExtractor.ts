/**
 * 145 Excellence — 우수 패턴 (다양성 + 성공 스트릭).
 *
 * 알고리즘 (도메인 무관):
 *   value = (diversityScore + streakRate) / 2
 *   - diversityScore = unique actionType 수 / 전체 액션 수 (0..1)
 *   - streakRate = 최장 연속 성공 스트릭 길이 / 전체
 *
 * evidence: 최장 성공 스트릭 액션들.
 */

import { applyEvidenceMapping, clamp01 } from "../extract-helpers.js";
import type {
  EvidencePointer,
  ExtractFeaturesParams,
  FeatureExtractionResult,
} from "../types.js";

export function extractExcellence(
  params: ExtractFeaturesParams,
): FeatureExtractionResult {
  const { session } = params;
  const n = session.actions.length;
  const evidence: EvidencePointer[] = [];
  if (n === 0) return { value: 0, evidence: [] };

  // 1. 액션 유형 다양성
  const uniqueTypes = new Set(session.actions.map((a) => a.actionType)).size;
  const diversityScore = uniqueTypes / n;

  // 2. 최장 성공 스트릭
  let longest = 0;
  let currentLen = 0;
  let longestStart = 0;
  let currentStart = 0;
  session.actions.forEach((a, idx) => {
    if (a.status === "success") {
      if (currentLen === 0) currentStart = idx;
      currentLen += 1;
      if (currentLen > longest) {
        longest = currentLen;
        longestStart = currentStart;
      }
    } else {
      currentLen = 0;
    }
  });
  const streakRate = longest / n;

  for (let i = longestStart; i < longestStart + longest; i++) {
    const a = session.actions[i]!;
    evidence.push({
      feature: "excellence",
      sessionId: session.sessionId,
      actionIndex: i,
      actionId: a.actionId,
      weight: 1 / n,
      reason: "success-streak",
    });
  }

  const value = clamp01((diversityScore + streakRate) / 2);
  applyEvidenceMapping(session, params.evidenceMapping, "excellence", evidence);
  return { value, evidence };
}
