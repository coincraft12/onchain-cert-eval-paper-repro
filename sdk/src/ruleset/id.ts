import { keccak256, stringToHex } from "viem";
import { canonicalSerialize } from "../canonical/serialize.js";
import type { RuleSetBody } from "./types.js";

/**
 * ruleSetId = keccak256(canonicalSerialize(ruleSetBody))  (특허 C-1 §3-4)
 *
 * 단 한 바이트라도 ruleSetBody가 바뀌면 ruleSetId도 바뀐다 — 평가 기준
 * 위·변조와 버전 혼용을 차단하는 핵심 메커니즘이다.
 */
export function computeRuleSetId(body: RuleSetBody): `0x${string}` {
  const canonical = canonicalSerialize(body);
  return keccak256(stringToHex(canonical));
}
