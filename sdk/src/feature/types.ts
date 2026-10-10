/**
 * FeatureVector (140) 타입 — 특허 C-1 §3-3.
 *
 * 5특성 141~145:
 *   141 efficiency    — 목표 달성 효율
 *   142 stability     — 안정성 (실패·재시도율)
 *   143 coherence     — 활동 일관성·계획성
 *   144 riskPattern   — 리스크 회피 (연속 실패·급한 재시도 없음이 높은 값)
 *   145 excellence    — 우수 패턴 (다양성·성공 스트릭)
 *
 * 각 값은 [0, 1] 정규화. 채점(150) 단계에서 RuleSet.featureWeights 로 가중 평균.
 *
 * evidence 는 감사·근거 추적용. 어느 액션이 어느 특성에 얼마나 기여했는지 pointer.
 */

import type { EvidenceMappingRule, FeatureWeights } from "../ruleset/types.js";
import type { BehaviorSession, Hex32 } from "../session/types.js";

export type FeatureKey = keyof FeatureWeights;

export interface FeatureVector {
  readonly efficiency: number;
  readonly stability: number;
  readonly coherence: number;
  readonly riskPattern: number;
  readonly excellence: number;
  readonly evidence: readonly EvidencePointer[];
}

export interface EvidencePointer {
  readonly feature: FeatureKey;
  readonly sessionId: Hex32;
  /** 세션 내 action 배열 인덱스 (0-based) */
  readonly actionIndex: number;
  /** 감사용 actionId 병기 */
  readonly actionId: string;
  /** 기여도. + = 양의 기여, - = 감점 */
  readonly weight: number;
  /** 사유 (알고리즘명·evidenceMapping 규칙명 등) */
  readonly reason: string;
}

export interface ExtractFeaturesParams {
  readonly session: BehaviorSession;
  /** RuleSet.evidenceMapping — actionType 별 특성 기여도 (선택) */
  readonly evidenceMapping?: readonly EvidenceMappingRule[];
}

/** 개별 extractor 반환 타입 */
export interface FeatureExtractionResult {
  readonly value: number;
  readonly evidence: readonly EvidencePointer[];
}
