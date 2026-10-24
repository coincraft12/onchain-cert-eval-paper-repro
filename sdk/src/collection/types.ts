/**
 * 수집·정규화 단계 (120) 타입.
 *
 * 특허 C-1 §3-1-b: StandardAction[] → NormalizedAction[] (UTC · dedup · finality).
 */

import type { StandardAction } from "../adapter/types.js";

/**
 * finality 기준 앵커. 이 시점 이후 값은 아직 변동 가능하므로 세션에서 제외한다.
 * 온체인 도메인은 blockNumber를, 오프체인 도메인은 timestamp를 쓴다.
 */
export interface FinalityAnchor {
  /** 결정적 세션화 기준 timestamp (초, UTC). timestamp <= 이면 확정 */
  readonly asOfTimestamp: number;
  /** 온체인 도메인용 기준 블록 (선택). blockNumber 정보가 domainMetadata에 있을 때 함께 검증 */
  readonly asOfBlockNumber?: bigint;
}

/**
 * 정규화된 액션 — StandardAction + finality 플래그.
 * 하위 스테이지(130 세션 구성)는 finalized=true 만 사용한다.
 */
export interface NormalizedAction extends StandardAction {
  /** finality anchor 시점 기준 확정 여부. false면 세션에 편입 금지 */
  readonly finalized: boolean;
  /** 정규화 원본 순번 (안정 정렬용) */
  readonly ingestOrder: number;
}
