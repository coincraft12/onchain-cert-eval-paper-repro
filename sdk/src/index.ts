/**
 * onchain-cert-eval-paper-repro — 평가 파이프라인 코어 재현 패키지.
 *
 * 원본 SDK에서 논문 실험 1·3·4가 실제로 사용하는 함수만
 * 추출했다. 발급(issue)·폐기(burn)·KMS 서명·검증자 네트워크 등 운영 전용 모듈은
 * 이 재현 저장소의 범위 밖이라 포함하지 않았다.
 */

export { canonicalSerialize, canonicalSerializeBytes, CanonicalSerializeError } from "./canonical/serialize.js";

export type { Grade, GradeThresholds, RuleSetBody, RuleSet } from "./ruleset/types.js";
export { computeRuleSetId } from "./ruleset/id.js";

// 110 DomainAdapter
export type {
  ActionStatus,
  StandardAction,
  DomainAdapter,
  CollectParams,
} from "./adapter/types.js";
export {
  OnchainTxAdapter,
  OnchainTxAdapterError,
} from "./adapter/OnchainTxAdapter.js";
export type {
  EtherscanRawTx,
  EtherscanInternalTx,
  EtherscanTokenTx,
  FetchLike,
  OnchainTxAdapterConfig,
} from "./adapter/OnchainTxAdapter.js";

// 120 Collection/정규화
export type { FinalityAnchor, NormalizedAction } from "./collection/types.js";
export { normalize, NormalizeError } from "./collection/normalize.js";
export type { NormalizeParams } from "./collection/normalize.js";

export type {
  FeatureWeights,
  SessionBoundaryRule,
  EvidenceMappingRule,
  StateMachineRule,
  StateTransition,
  SimilarityRule,
  SimilarityWeights,
} from "./ruleset/types.js";

// 130 SessionConstructor
export type {
  BehaviorSession,
  SessionConstructionMethod,
  Hex32,
} from "./session/types.js";
export {
  actionLeafHash,
  computeSessionRoot,
} from "./session/computeSessionRoot.js";
export {
  SessionConstructorError,
  computeSessionId,
  constructSessions,
} from "./session/SessionConstructor.js";
export type { ConstructSessionsParams } from "./session/SessionConstructor.js";

// 140 FeatureExtractor
export type {
  FeatureKey,
  FeatureVector,
  EvidencePointer,
  ExtractFeaturesParams,
  FeatureExtractionResult,
} from "./feature/types.js";
export { clamp01, applyEvidenceMapping } from "./feature/extract-helpers.js";
export { extractFeatures } from "./feature/extractFeatures.js";
export { extractEfficiency } from "./feature/extractors/EfficiencyExtractor.js";
export { extractStability } from "./feature/extractors/StabilityExtractor.js";
export { extractCoherence } from "./feature/extractors/CoherenceExtractor.js";
export { extractRiskPattern } from "./feature/extractors/RiskPatternExtractor.js";
export { extractExcellence } from "./feature/extractors/ExcellenceExtractor.js";

// 150 Scorer
export type {
  FeatureBreakdown,
  ScoringResult,
} from "./scorer/types.js";
export { ScorerError, score } from "./scorer/scorer.js";
export type { ScoreParams } from "./scorer/scorer.js";
export { classifyGrade } from "./scorer/grade.js";

// 160 ReportGenerator — 다세션 집계만 (EIP-712 ResultReport 빌더는 범위 밖)
export { aggregateSessionRoots } from "./report/aggregateSessionRoots.js";

// EvaluationReport v1 + reportHash v1/v2 (docs: README "Credential verification")
export type { Address, ReportHashFields, ReportHashFieldsV2 } from "./report/reportHash.js";
export { GRADE_INDEX, computeReportHash, computeReportHashV2 } from "./report/reportHash.js";
export {
  EVALUATION_REPORT_VERSION,
  HASH_SCHEME_V2,
  EvaluationReportError,
  actionToTxHash,
  extractIncludedTxHashes,
  extractTxActionTypes,
  buildEvaluationReport,
  computeEvaluationReportHash,
  toEnvelope,
} from "./report/evaluation.js";
export type {
  EvaluatorCodeVersion,
  MissionScope,
  EvaluationSessionEntry,
  EvaluationReport,
  EvaluationReportEnvelope,
  BuildEvaluationReportInput,
} from "./report/evaluation.js";

// 읽기 전용 검증에 필요한 배포 컨트랙트 ABI (검증된 공개 ABI)
export { competencyAttestationSBTV4Abi } from "./abis/CompetencyAttestationSBTV4.js";
