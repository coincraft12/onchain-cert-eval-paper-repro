/**
 * 수집·정규화 (120) — StandardAction[] → NormalizedAction[].
 *
 * 특허 C-1 §3-1-b. 결정성 보장 4원칙:
 *   1. UTC 통일 — timestamp는 이미 UNIX epoch(초)이므로 유효성만 검증
 *   2. dedup — actionId 기준. 중복 시 첫 항목만 유지 (재입력 안정성)
 *   3. finality — asOfTimestamp 이후 발생한 액션은 finalized=false 로 표시
 *   4. parentActions DAG 정합성 — 참조하는 부모가 세트 안에 존재해야 함 (기본 강제, skip 가능)
 *
 * 반환 배열은 (timestamp asc, actionId asc)로 안정 정렬된다.
 * 같은 입력 → 같은 순서 → 같은 sessionRoot의 전제 조건.
 */

import type { StandardAction } from "../adapter/types.js";
import type { FinalityAnchor, NormalizedAction } from "./types.js";

export class NormalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizeError";
  }
}

export interface NormalizeParams {
  readonly actions: readonly StandardAction[];
  readonly anchor: FinalityAnchor;
  /**
   * parentActions 참조 무결성 정책 (기본 `"strict"`).
   *   - `"strict"`: 참조 부모가 존재하지 않으면 NormalizeError
   *   - `"drop-orphans"`: 참조 무결성 위반한 액션 자체를 제외
   *   - `"skip"`: 검증 안 함 (실전 fixture 회귀·초기 개발용)
   */
  readonly parentIntegrity?: "strict" | "drop-orphans" | "skip";
}

function toNormalized(
  action: StandardAction,
  ingestOrder: number,
  finalized: boolean,
): NormalizedAction {
  const base: NormalizedAction = {
    actionId: action.actionId,
    timestamp: action.timestamp,
    actor: action.actor,
    actionType: action.actionType,
    status: action.status,
    domainMetadata: action.domainMetadata,
    ingestOrder,
    finalized,
  };
  return {
    ...base,
    ...(action.inputDigest !== undefined ? { inputDigest: action.inputDigest } : {}),
    ...(action.outputDigest !== undefined ? { outputDigest: action.outputDigest } : {}),
    ...(action.parentActions !== undefined ? { parentActions: action.parentActions } : {}),
  };
}

export function normalize(params: NormalizeParams): readonly NormalizedAction[] {
  const { actions, anchor } = params;
  const parentIntegrity = params.parentIntegrity ?? "strict";

  if (!Number.isFinite(anchor.asOfTimestamp) || anchor.asOfTimestamp < 0) {
    throw new NormalizeError(`invalid asOfTimestamp: ${anchor.asOfTimestamp}`);
  }

  // 1) dedup by actionId (첫 항목만) — ingestOrder=원본 인덱스
  const seen = new Map<string, { action: StandardAction; ingestOrder: number }>();
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (!a) continue; // noUncheckedIndexedAccess
    if (!a.actionId) throw new NormalizeError(`action[${i}] missing actionId`);
    if (!Number.isFinite(a.timestamp) || a.timestamp < 0) {
      throw new NormalizeError(`action[${i}] invalid timestamp: ${a.timestamp}`);
    }
    if (seen.has(a.actionId)) continue;
    seen.set(a.actionId, { action: a, ingestOrder: i });
  }

  // 2) parentActions DAG 정합성 (whitepaper §3-1-b) — 참조 부모가 세트 안에 존재해야
  const orphans = new Set<string>();
  if (parentIntegrity !== "skip") {
    for (const { action } of seen.values()) {
      if (!action.parentActions || action.parentActions.length === 0) continue;
      for (const parentId of action.parentActions) {
        if (!seen.has(parentId)) {
          if (parentIntegrity === "strict") {
            throw new NormalizeError(
              `action[${action.actionId}] parent[${parentId}] not present in batch`,
            );
          }
          orphans.add(action.actionId);
          break;
        }
      }
    }
  }

  // 3) finality 판정 (drop-orphans 시 orphan 제외)
  const normalized: NormalizedAction[] = [];
  for (const { action, ingestOrder } of seen.values()) {
    if (orphans.has(action.actionId)) continue;
    normalized.push(
      toNormalized(action, ingestOrder, action.timestamp <= anchor.asOfTimestamp),
    );
  }

  // 4) 안정 정렬 (timestamp asc, actionId asc)
  normalized.sort((x, y) => {
    if (x.timestamp !== y.timestamp) return x.timestamp - y.timestamp;
    if (x.actionId < y.actionId) return -1;
    if (x.actionId > y.actionId) return 1;
    return 0;
  });

  return normalized;
}
