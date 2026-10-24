/**
 * reportHash v1 / v2 계산 — 온체인 SBT의 reportHash(bytes32)가 무엇을 가리키는지 재계산하기 위한 함수.
 * 원본(onchain-cert-system sdk/src/report/build.ts)에서 해시 계산부만 발췌했다.
 * ResultReport 빌더·EIP-712 서명·발급 호출은 운영 발급 전용이라 이 저장소 범위 밖이다.
 *
 * 컨트랙트는 reportHash를 불투명 bytes32로만 다룬다(reportHashConsumed 키).
 *   v1 = keccak256(abi.encode(12필드))
 *   v2 = keccak256(abi.encode(12필드, bytes32 evaluationReportHash))
 */
import { encodeAbiParameters, keccak256 } from "viem";
import type { Grade } from "../ruleset/types.js";

export type Hex32 = `0x${string}`;
export type Address = `0x${string}`;

export const GRADE_INDEX: Record<Grade, number> = {
  Below: 0,
  Basic: 1,
  Associate: 2,
  Professional: 3,
};

/** reportHash 계산에 쓰이는 12개 필드 (ResultReport에서 reportHash를 뺀 것 중 해시에 들어가는 부분) */
export interface ReportHashFields {
  readonly userAddress: Address;
  readonly missionId: Hex32;
  readonly score: number;
  readonly grade: number;
  readonly ruleSetId: Hex32;
  readonly sessionRoot: Hex32;
  readonly nonce: bigint;
  readonly expiry: bigint;
  readonly timestamp: bigint;
  readonly applicantName: string;
  readonly courseId: Hex32;
  readonly issuerAddress: Address;
}

export type ReportHashFieldsV2 = ReportHashFields & { readonly evaluationReportHash: Hex32 };

const V1_TYPES = [
  { type: "address" }, // userAddress
  { type: "bytes32" }, // missionId
  { type: "uint16" }, // score
  { type: "uint8" }, // grade
  { type: "bytes32" }, // ruleSetId
  { type: "bytes32" }, // sessionRoot
  { type: "uint256" }, // nonce
  { type: "uint256" }, // expiry
  { type: "uint256" }, // timestamp
  { type: "string" }, // applicantName
  { type: "bytes32" }, // courseId
  { type: "address" }, // issuerAddress
] as const;

function v1Values(i: ReportHashFields) {
  return [
    i.userAddress, i.missionId, i.score, i.grade, i.ruleSetId, i.sessionRoot,
    i.nonce, i.expiry, i.timestamp, i.applicantName, i.courseId, i.issuerAddress,
  ] as const;
}

/** reportHash v1 (12필드). 경로 B와 과거 발급(운영 #1)이 사용한다. */
export function computeReportHash(input: ReportHashFields): Hex32 {
  return keccak256(encodeAbiParameters(V1_TYPES, v1Values(input)));
}

/** reportHash v2 (12필드 + 13번째 evaluationReportHash). 경로 A 평가 보고서와 온체인을 묶는다. */
export function computeReportHashV2(input: ReportHashFieldsV2): Hex32 {
  return keccak256(
    encodeAbiParameters([...V1_TYPES, { type: "bytes32" }] as const, [...v1Values(input), input.evaluationReportHash] as const),
  );
}
