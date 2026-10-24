/**
 * 143 Coherence — 활동 일관성·계획성.
 *
 * 알고리즘 (도메인 무관):
 *   value = 0.7 × regularityScore + 0.3 × chainRate
 *   - regularityScore = 1 / (1 + cv)  where cv = 액션 간 간격의 변동계수
 *     (간격이 규칙적일수록 1, 들쭉날쭉할수록 0에 가까움) — 응시자가 계획적으로 시간 배분했는지
 *   - chainRate = parentActions 있는 액션 / 전체
 *     (연쇄 활동이 많을수록 계획적) — 도메인 특성상 낮게 나오는 경우 많음
 *
 * 가중치 근거 (2026-07-06 튜닝): 실 응시자는 대부분 로컬 배포라 tx 간 parentActions 참조 낮음.
 * 시간 규칙성이 더 신뢰할 만한 계획성 지표.
 *
 * evidence: parentActions 참조 액션 각각.
 */

import { applyEvidenceMapping, clamp01 } from "../extract-helpers.js";
import type {
  EvidencePointer,
  ExtractFeaturesParams,
  FeatureExtractionResult,
} from "../types.js";

export function extractCoherence(
  params: ExtractFeaturesParams,
): FeatureExtractionResult {
  const { session } = params;
  const n = session.actions.length;
  if (n === 0) return { value: 0, evidence: [] };
  // 단일 액션은 시간 규칙성·연쇄 판정 어려움 → 중립값
  if (n === 1) {
    const evidence: EvidencePointer[] = [];
    applyEvidenceMapping(session, params.evidenceMapping, "coherence", evidence);
    return { value: 0.5, evidence };
  }

  // 1. 시간 간격 변동계수 (cv)
  const gaps: number[] = [];
  for (let i = 1; i < n; i++) {
    gaps.push(session.actions[i]!.timestamp - session.actions[i - 1]!.timestamp);
  }
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  let variance = 0;
  for (const g of gaps) variance += (g - mean) ** 2;
  variance /= gaps.length;
  const stddev = Math.sqrt(variance);
  const cv = mean > 0 ? stddev / mean : 0;
  const regularityScore = 1 / (1 + cv);

  // 2. parentActions 연쇄 비율
  let chained = 0;
  const evidence: EvidencePointer[] = [];
  session.actions.forEach((a, idx) => {
    if (a.parentActions && a.parentActions.length > 0) {
      chained += 1;
      evidence.push({
        feature: "coherence",
        sessionId: session.sessionId,
        actionIndex: idx,
        actionId: a.actionId,
        weight: 1 / n,
        reason: `chained:${a.parentActions.length}`,
      });
    }
  });
  const chainRate = chained / n;

  // 가중치: regularity 0.7 (신뢰) · chainRate 0.3 (보조)
  const value = clamp01(0.7 * regularityScore + 0.3 * chainRate);
  applyEvidenceMapping(session, params.evidenceMapping, "coherence", evidence);
  return { value, evidence };
}
