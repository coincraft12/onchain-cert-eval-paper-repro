/**
 * sessionRoot 산출 — 특허 C-1 §3-2 sessionRoot 정의.
 *
 * sessionRoot = MerkleRoot(keccak256(canonicalSerialize(action.core))_i)
 *
 * 결정성 조건:
 *   1. leaf 순서 = 세션 편입 순서 (정규화 단계에서 이미 결정적 정렬)
 *   2. leaf hash = 도메인 무관 core 필드만 canonical 직렬화
 *      (domainMetadata 제외 — 그래야 새 도메인 붙여도 leaf hash 동일 규칙)
 *   3. pair hash = keccak256(left || right)  (order-preserving — 액션 순서가 root에 반영)
 *      * sorted-pair 방식은 leaf 순서를 지우므로 사용 안 함
 *   4. 홀수 leaf 시 마지막을 자기 자신과 pair
 */

import { concat, keccak256, stringToHex } from "viem";
import { canonicalSerialize } from "../canonical/serialize.js";
import type { NormalizedAction } from "../collection/types.js";
import type { Hex32 } from "./types.js";

const ZERO_ROOT: Hex32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * 도메인 무관 core 필드만 남긴 leaf hash.
 * domainMetadata / finalized / ingestOrder 제외 (C-1 무관성 유지).
 */
export function actionLeafHash(a: NormalizedAction): Hex32 {
  const core: Record<string, unknown> = {
    actionId: a.actionId,
    timestamp: a.timestamp,
    actor: a.actor,
    actionType: a.actionType,
    status: a.status,
  };
  if (a.inputDigest !== undefined) core.inputDigest = a.inputDigest;
  if (a.outputDigest !== undefined) core.outputDigest = a.outputDigest;
  if (a.parentActions !== undefined) core.parentActions = a.parentActions;
  const canonical = canonicalSerialize(core);
  return keccak256(stringToHex(canonical));
}

/**
 * 정규화된 액션 배열에서 sessionRoot 계산.
 * 빈 배열은 zero root (감사 편의).
 */
export function computeSessionRoot(
  actions: readonly NormalizedAction[],
): Hex32 {
  if (actions.length === 0) return ZERO_ROOT;
  const leaves = actions.map(actionLeafHash);
  return merkleRoot(leaves);
}

function merkleRoot(leaves: readonly Hex32[]): Hex32 {
  if (leaves.length === 0) return ZERO_ROOT;
  if (leaves.length === 1) return leaves[0]!;

  const next: Hex32[] = [];
  for (let i = 0; i < leaves.length; i += 2) {
    const left = leaves[i]!;
    const right = i + 1 < leaves.length ? leaves[i + 1]! : left; // 홀수: 자기 자신과 pair
    next.push(hashPair(left, right));
  }
  return merkleRoot(next);
}

/**
 * order-preserving pair hash — 액션 순서가 root 에 반영되어야 하므로 sorted 하지 않음.
 * sorted-pair 는 order-invariant 라 세션의 시간순 정보가 지워진다.
 */
function hashPair(left: Hex32, right: Hex32): Hex32 {
  return keccak256(concat([left, right]));
}
