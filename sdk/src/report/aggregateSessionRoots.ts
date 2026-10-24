/**
 * 여러 세션의 sessionRoot를 결정적 Merkle root 하나로 집계.
 *   0개 → zero root
 *   1개 → 그대로
 *   2개 이상 → order-preserving pair keccak
 *
 * 원본(onchain-cert-system sdk/src/report/pathA.ts)에서 aggregateSessionRoots()만
 * 추출한 버전 — buildPathAResultReport()(EIP-712 서명 대상 ResultReport 빌더, 운영 발급 전용)는
 * 이 재현 저장소 범위 밖이라 포함하지 않았다.
 */
import { concat, keccak256 } from "viem";
import type { BehaviorSession, Hex32 } from "../session/types.js";

const ZERO_ROOT: Hex32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export function aggregateSessionRoots(
  sessions: readonly BehaviorSession[],
): Hex32 {
  if (sessions.length === 0) return ZERO_ROOT;
  if (sessions.length === 1) return sessions[0]!.sessionRoot;
  return merkleRoot(sessions.map((s) => s.sessionRoot));
}

function merkleRoot(leaves: readonly Hex32[]): Hex32 {
  if (leaves.length === 0) return ZERO_ROOT;
  if (leaves.length === 1) return leaves[0]!;
  const next: Hex32[] = [];
  for (let i = 0; i < leaves.length; i += 2) {
    const left = leaves[i]!;
    const right = i + 1 < leaves.length ? leaves[i + 1]! : left;
    next.push(keccak256(concat([left, right])));
  }
  return merkleRoot(next);
}
