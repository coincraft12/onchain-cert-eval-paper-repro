/**
 * RuleSet — 채점 규칙 집합 (특허 C-1 §3-4, §5-4).
 *
 * v1 Path B (오프체인 평가) 기본. v1 확장으로 Path A 필드(featureWeights, sessionBoundaryRule,
 * evidenceMapping)를 optional 로 추가. 기존 Path B RuleSet은 새 필드를 생략하므로
 * canonicalSerialize 결과가 변하지 않아 ruleSetId 하위 호환.
 *
 * canonicalSerialize() 입력으로 ruleSetId가 결정되므로 필드 추가/변경은 신중히.
 */

export type Grade = "Below" | "Basic" | "Associate" | "Professional";

export interface GradeThresholds {
  readonly professional?: number;
  readonly associate?: number;
  readonly basic: number;
}

/**
 * Path A 5특성 가중치 (합=1.0 권장, 강제 아님 — Scorer가 정규화).
 * 특허 C-1 §3-3 (141~145) 원문 정합.
 */
export interface FeatureWeights {
  readonly efficiency: number;   // 141
  readonly stability: number;    // 142
  readonly coherence: number;    // 143
  readonly riskPattern: number;  // 144
  readonly excellence: number;   // 145
}

/**
 * 세션 경계 규칙 (특허 C-1 §3-2 결정적 세션화).
 * SessionConstructor(130)가 이 규칙을 참조해 NormalizedAction[] 을 세션 단위로 분할.
 *
 * v1: timeout (131) + boundaryActionTypes (132 부분)
 * v2: stateMachine (134) + similarityRule (133). tx-dag (135) 는 parentActions 재활용이라 규칙 불필요.
 */
export interface SessionBoundaryRule {
  /** 활동 없이 이 시간(초) 넘으면 세션 종료 (131 time-timeout) */
  readonly timeoutSeconds: number;
  /** 특정 actionType 목록 발생 시 세션 경계로 취급 (132 boundary-events, 선택) */
  readonly boundaryActionTypes?: readonly string[];
  /** 세션 유효화 최소 액션 수 (선택). 미만이면 세션 무효 */
  readonly minActionCount?: number;
  /** 상태 머신 기반 세션화 (134 state-machine). 선택 */
  readonly stateMachine?: StateMachineRule;
  /** 유사도 그래프 기반 세션화 (133 similarity-graph). 선택 */
  readonly similarityRule?: SimilarityRule;
}

/**
 * 134 상태 머신 규칙 (whitepaper §3-2 우선순위 2위).
 * 미리 정의된 미션 상태 전이 모델에 따라 액션을 관측값으로 상태 전이.
 * 허용되지 않는 전이 관측 시 policy 대로 처리.
 */
export interface StateMachineRule {
  readonly initialState: string;
  readonly transitions: readonly StateTransition[];
  readonly terminalStates: readonly string[];
  /**
   * 허용되지 않는 전이 관측 시:
   *   - "new-session": 세션 종료 후 새 세션 시작 (해당 액션이 새 세션 첫 원소)
   *   - "mark-violation": 현재 세션 유지하되 stepViolations 에 기록
   *   - "reject-action": 액션을 세션에서 제외 (감사 흔적만 유지)
   */
  readonly invalidTransitionPolicy: "new-session" | "mark-violation" | "reject-action";
}

export interface StateTransition {
  /** 현재 상태 */
  readonly from: string;
  /** 관측된 actionType (일치해야 전이 발동) */
  readonly actionType: string;
  /** 전이 후 상태 */
  readonly to: string;
}

/**
 * 133 유사도 그래프 규칙 (whitepaper §3-2 우선순위 4위).
 * 액션 쌍의 가중 유사도 합산 >= threshold 이면 같은 세션.
 * 유사도는 domainMetadata 필드에서 계산되므로 C-1 무관성 관점에서는
 * 어댑터가 표준 시그니처 필드를 제공한다는 전제 (§5-1 NormalizedTx 참고).
 */
export interface SimilarityRule {
  /** 유사도 합 임계치 (0.0 ~ 1.0). 이 값 이상이면 같은 세션 편입 */
  readonly threshold: number;
  /** 각 특성 가중치 (합=1.0 권장. Scorer 정규화 예정) */
  readonly weights: SimilarityWeights;
}

export interface SimilarityWeights {
  /** 함수 selector 일치 (actionType 정확 매칭) */
  readonly functionSelector: number;
  /** 이벤트 signature 일치 (parentActions[0] 동일 등) */
  readonly eventSignature: number;
  /** 실패 유형 일치 (status 동일) */
  readonly failureType: number;
  /** state key 겹침 (domainMetadata.stateDiff 키 교집합, 있을 때만) */
  readonly stateKeyOverlap: number;
  /** 호출 대상 컨트랙트 동일성 (domainMetadata.to 동일) */
  readonly contractIdentity: number;
}

/** 특정 actionType 관측 시 어느 특성에 얼마 기여시킬지 매핑 (특허 C-1 §3-3) */
export interface EvidenceMappingRule {
  /** DomainAdapter가 표준화한 actionType (예: "swap", "deploy", "transferOwnership") */
  readonly actionType: string;
  /** 특성별 기여도. 절대값이 아니라 상대 가중치. Scorer가 세션 내 합산 후 [0,1] 정규화 */
  readonly contributions: {
    readonly efficiency?: number;
    readonly stability?: number;
    readonly coherence?: number;
    readonly riskPattern?: number;
    readonly excellence?: number;
  };
  /**
   * 이 actionType 이 세션에 **한 번도 등장 안 하면** 각 feature 값에서 감점 (0~1 범위).
   * 부정행위 감지 (예: `transferOwnership` 없음 = Timelock 우회 → riskPattern 큰 감점).
   * 알고리즘: 세션 전체에 해당 actionType 없으면 feature -= penalty, clamp [0,1].
   * 없거나 0 이면 감점 없음.
   */
  readonly absencePenalty?: {
    readonly efficiency?: number;
    readonly stability?: number;
    readonly coherence?: number;
    readonly riskPattern?: number;
    readonly excellence?: number;
  };
}

/** RuleSet 본문 — ruleSetId 계산 대상. Path A/B 겸용 필드 구성. */
export interface RuleSetBody {
  /** 사람이 읽기 쉬운 버전 (semver 권장) */
  readonly version: string;
  /** 적용 미션/과정 식별자 (예: "WEB3-ARCH-BASIC") */
  readonly missionId: string;
  /** 적용 트랙 (선택) */
  readonly trackId?: string;
  /** 적용 체인 ID 목록 (Sepolia=11155111, Polygon=137) */
  readonly chainScope: readonly number[];
  /** 유효 시작 UNIX timestamp (초) */
  readonly validFrom: number;
  /** 유효 종료 UNIX timestamp (초). 생략 시 영구 */
  readonly validTo?: number;

  /** 등급 임계치 (점수 기준) */
  readonly gradeThresholds: GradeThresholds;

  /**
   * Path B 전용 — 시험 메타데이터. Path A 전용 RuleSet에서는 생략.
   * 생략된 필드는 canonicalSerialize 결과에서 빠지므로 기존 ruleSetId 하위 호환 유지.
   */
  readonly examMeta?: {
    readonly totalQuestions: number;
    readonly passingScore: number;
    readonly questionBankRef: string;
  };

  /** Path A — 5특성 가중치. Path B RuleSet에서는 생략 */
  readonly featureWeights?: FeatureWeights;

  /** Path A — 세션 경계 규칙. Path B RuleSet에서는 생략 */
  readonly sessionBoundaryRule?: SessionBoundaryRule;

  /** Path A — actionType → feature 기여도 매핑. Path B RuleSet에서는 생략 */
  readonly evidenceMapping?: readonly EvidenceMappingRule[];

  /**
   * 발급 가능 Issuer 주소 목록 (lowercased 0x...). 발급 시점의 권한 구조 스냅샷.
   * 실제 발급 검증은 컨트랙트가 ValidatorRegistry로 수행 — 본 필드는 감사 추적용.
   */
  readonly issuerSet: readonly `0x${string}`[];
}

/** ruleSetId가 부착된 RuleSet (런타임 조회용) */
export interface RuleSet extends RuleSetBody {
  readonly ruleSetId: `0x${string}`; // bytes32 hex
}
