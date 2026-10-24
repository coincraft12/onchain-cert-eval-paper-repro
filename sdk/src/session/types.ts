/**
 * 세션 구성부 (130) 타입 — 특허 C-1 §3-2, §5-2 정합.
 *
 * BehaviorSession = 결정적 세션화의 산출물.
 *   동일 (입력 액션 + ruleSet + referenceBlockNumber) → 항상 동일 sessionRoot·sessionId.
 *
 * SessionBoundaryRule 은 `ruleset/types.ts` 정의를 그대로 재사용 (버전은 ruleSetId 로 락인).
 */

import type { NormalizedAction } from "../collection/types.js";

export type Hex32 = `0x${string}`;

/**
 * 세션 경계 결정 방식 (whitepaper §3-2, 131~135).
 * 우선순위 (whitepaper §3-2 알고리즘 라우팅 원문):
 *   step-transition > state-machine > tx-dag > similarity-graph > time-timeout
 * "combined" 는 여러 규칙을 병렬 적용 (OR).
 */
export type SessionConstructionMethod =
  | "time-timeout"       // 131 (기본 fallback)
  | "boundary-events"    // 132 부분 (특정 actionType 등장 시 세션 경계)
  | "state-machine"      // 134 (v2 예정)
  | "similarity-graph"   // 133 (v2 예정)
  | "tx-dag"             // 135 (v2 예정)
  | "combined";

export interface BehaviorSession {
  /** = keccak256(canonicalSerialize({ subject, missionId, ruleSetId, startTime, endTime, sessionRoot })) */
  readonly sessionId: Hex32;

  /** 행위 주체 (지갑 주소 · userId · 응시자ID). NormalizedAction.actor 계열 */
  readonly subject: string;

  readonly missionId: string;
  readonly ruleSetId: Hex32;

  /** 온체인 도메인일 때만 사용 */
  readonly chainId?: number;
  readonly referenceBlockNumber?: bigint;

  readonly constructionMethod: SessionConstructionMethod;

  /** 이 세션에 편입된 액션들. 정규화 완료 상태 그대로 (timestamp asc, actionId asc) */
  readonly actions: readonly NormalizedAction[];

  readonly startTime: number;
  readonly endTime: number;

  /** = MerkleRoot(keccak256(canonicalSerialize(action.core))_i) — 도메인 무관 */
  readonly sessionRoot: Hex32;

  /**
   * 유효성. minActionCount 미달 등 위반 시 false.
   * 무효 세션도 반환 대상 — 감사·재구성 근거로 유지.
   */
  readonly valid: boolean;

  /** 위반 리스트 (선택). valid=false 일 때 채워짐 */
  readonly stepViolations?: readonly string[];

  /**
   * state machine terminal 도달 여부 (state-machine · combined 방식만 유효).
   * 도달 = 응시자가 요구 절차 완주. 스코어링 시 보너스 반영.
   * 다른 방식은 undefined (해당 없음).
   */
  readonly reachedTerminal?: boolean;
}
