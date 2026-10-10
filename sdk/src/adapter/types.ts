/**
 * DomainAdapter (110) — 도메인 무관 표준 스키마 + 어댑터 인터페이스.
 *
 * 특허 C-1 §3-1 (도메인 어댑터) + §5-0 (StandardAction).
 * 파이프라인의 유일한 도메인 의존 지점. 어댑터만 교체하면 120→180은 재사용된다.
 */

export type ActionStatus = "success" | "fail" | "partial";

/**
 * 모든 도메인 어댑터의 출력 타입.
 * 도메인 특화 정보는 `domainMetadata`에 수납해서 하위 스테이지(120→180)를 오염시키지 않는다.
 */
export interface StandardAction {
  /** 행위 고유 식별자 (도메인 내 유일). 예: EVM tx hash, LMS 제출 ID */
  readonly actionId: string;
  /** UNIX timestamp (초, UTC). 어댑터가 보정 후 넘긴다 */
  readonly timestamp: number;
  /** 행위 주체 식별자 (지갑주소 / userId / 응시자ID) — 어댑터가 lowercase 정규화 */
  readonly actor: string;
  /** 행위 유형 코드 — 도메인 어댑터가 표준 코드로 변환 (예: EVM function selector) */
  readonly actionType: string;
  /** 행위 입력값 요약 해시 (선택). 재현성 확보용 */
  readonly inputDigest?: string;
  /** 결과 상태 */
  readonly status: ActionStatus;
  /** 행위 출력값 요약 해시 (선택) */
  readonly outputDigest?: string;
  /** 선행 행위 ID 목록 (DAG 구성용, 선택) */
  readonly parentActions?: readonly string[];
  /** 도메인 특화 원본 데이터 — 하위 스테이지는 이 필드에 의존하지 않는다 (C-1 무관성 유지) */
  readonly domainMetadata: Readonly<Record<string, unknown>>;
}

/**
 * 어댑터가 원시 로그를 수집할 때 넘기는 파라미터.
 * windowEnd는 finality anchor(§3-1-b 데이터 확정)의 근거로 쓴다.
 */
export interface CollectParams {
  readonly actor: string;
  readonly taskId: string;
  readonly windowStart?: number;
  readonly windowEnd?: number;
}

/**
 * 도메인 어댑터 인터페이스 (C-1 §3-1).
 *
 * 새 도메인을 추가할 때 구현할 유일한 접점. 하위 파이프라인은 이 인터페이스만 본다.
 */
export interface DomainAdapter<RawLog = unknown> {
  /** 도메인 식별자 (예: 'onchain-evm', 'lms', 'medical-sim') */
  readonly domainId: string;
  /** 데이터 소스 유형 (예: 'rpc', 'etherscan', 'api', 'db') */
  readonly sourceInterface: string;

  /** 원시 행위 로그 수집. 반환 타입은 도메인별 원시 스키마 */
  collect(params: CollectParams): Promise<readonly RawLog[]>;

  /** 원시 로그 1건을 표준 스키마로 변환 */
  normalize(rawLog: RawLog): StandardAction;

  /** 수집 + 정규화 통합 (편의 메서드 — 기본 구현은 collect().map(normalize)) */
  collectAndNormalize(params: CollectParams): Promise<readonly StandardAction[]>;
}
