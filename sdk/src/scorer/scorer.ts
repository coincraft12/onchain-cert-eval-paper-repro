/**
 * Scorer (150) — 특허 C-1 §3-4.
 *
 * FeatureVector + weights + gradeThresholds → ScoringResult.
 *
 * 결정성: 같은 입력 → 같은 score/grade. floating-point 는 두 자리 반올림으로 결정성 보강.
 */

import type { FeatureVector } from "../feature/types.js";
import type { FeatureWeights, GradeThresholds } from "../ruleset/types.js";
import { classifyGrade } from "./grade.js";
import type { FeatureBreakdown, ScoringResult } from "./types.js";

export class ScorerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScorerError";
  }
}

export interface ScoreParams {
  readonly features: FeatureVector;
  readonly weights: FeatureWeights;
  readonly thresholds: GradeThresholds;
}

export function score(params: ScoreParams): ScoringResult {
  const { features, weights, thresholds } = params;

  for (const [k, w] of Object.entries(weights) as [keyof FeatureWeights, number][]) {
    if (!Number.isFinite(w) || w < 0) {
      throw new ScorerError(`weight[${k}] must be >= 0 (got ${w})`);
    }
  }
  const totalWeight =
    weights.efficiency +
    weights.stability +
    weights.coherence +
    weights.riskPattern +
    weights.excellence;
  if (totalWeight <= 0) throw new ScorerError("total weight must be > 0");

  const weightedContributions: FeatureBreakdown = {
    efficiency: features.efficiency * weights.efficiency,
    stability: features.stability * weights.stability,
    coherence: features.coherence * weights.coherence,
    riskPattern: features.riskPattern * weights.riskPattern,
    excellence: features.excellence * weights.excellence,
  };

  const weightedSum =
    weightedContributions.efficiency +
    weightedContributions.stability +
    weightedContributions.coherence +
    weightedContributions.riskPattern +
    weightedContributions.excellence;

  // 0~100, 정수 반올림 (RuleSet.gradeThresholds 도 정수 기준)
  const rawScore = (100 * weightedSum) / totalWeight;
  const finalScore = Math.round(rawScore);
  const grade = classifyGrade(finalScore, thresholds);

  const featureBreakdown: FeatureBreakdown = {
    efficiency: features.efficiency,
    stability: features.stability,
    coherence: features.coherence,
    riskPattern: features.riskPattern,
    excellence: features.excellence,
  };

  return {
    score: finalScore,
    grade,
    featureBreakdown,
    weightedContributions,
    evidence: features.evidence,
  };
}
