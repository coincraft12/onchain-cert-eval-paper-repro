/**
 * Scorer (150) 결과 타입 — 특허 C-1 §3-4.
 *
 * FeatureVector + RuleSet(featureWeights + gradeThresholds) → ScoringResult
 *   score: 0~100 (가중 평균 × 100)
 *   grade: gradeThresholds 로 분류
 *   featureBreakdown: 각 특성 원값 (감사·시각화)
 *   weightedContributions: 각 특성 × 가중치 (감사·기여도 분석)
 */

import type { EvidencePointer, FeatureVector } from "../feature/types.js";
import type { Grade } from "../ruleset/types.js";

export interface FeatureBreakdown {
  readonly efficiency: number;
  readonly stability: number;
  readonly coherence: number;
  readonly riskPattern: number;
  readonly excellence: number;
}

export interface ScoringResult {
  /** 0~100 정수 반올림 */
  readonly score: number;
  readonly grade: Grade;
  /** 원 feature 값 (0~1) */
  readonly featureBreakdown: FeatureBreakdown;
  /** 가중치 적용 후 (feature × weight, 정규화 전) */
  readonly weightedContributions: FeatureBreakdown;
  /** 감사용 근거 pointer (FeatureVector.evidence 그대로 승계) */
  readonly evidence: readonly EvidencePointer[];
}

export type { FeatureVector };
