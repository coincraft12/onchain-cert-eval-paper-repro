/**
 * 142 Stability — 안정성 (실패·중단 없이 수행).
 *
 * 알고리즘: value = 1 - failRate
 *   - failRate = fail_actions / total_actions
 *   - "partial" 은 절반 실패 (0.5 가중)
 *
 * evidence: fail 액션 각각.
 */

import { applyEvidenceMapping, clamp01 } from "../extract-helpers.js";
import type {
  EvidencePointer,
  ExtractFeaturesParams,
  FeatureExtractionResult,
} from "../types.js";

export function extractStability(
  params: ExtractFeaturesParams,
): FeatureExtractionResult {
  const { session } = params;
  const n = session.actions.length;
  if (n === 0) return { value: 0, evidence: [] };

  let failWeight = 0;
  const evidence: EvidencePointer[] = [];
  session.actions.forEach((a, idx) => {
    let w = 0;
    if (a.status === "fail") w = 1;
    else if (a.status === "partial") w = 0.5;
    if (w > 0) {
      failWeight += w;
      evidence.push({
        feature: "stability",
        sessionId: session.sessionId,
        actionIndex: idx,
        actionId: a.actionId,
        weight: -w / n,
        reason: a.status,
      });
    }
  });

  const value = clamp01(1 - failWeight / n);
  applyEvidenceMapping(session, params.evidenceMapping, "stability", evidence);
  return { value, evidence };
}
