/**
 * EvaluationReport v1 — 경로 A 오프체인 평가 보고서 (docs/evaluation-report-v1.md).
 *
 * 온체인에는 evaluationReportHash 하나만 reportHash v2(13번째 필드)로 들어간다.
 * 컨트랙트는 reportHash를 불투명 bytes32로만 다루므로 컨트랙트 변경은 없다.
 *
 * 개인정보: 신청자 이름·이름 해시·생년월일은 이 보고서에 넣지 않는다.
 * 결정성: Date.now()·무작위 금지. createdAt은 발급 ResultReport.timestamp를 그대로 쓴다.
 */

import { keccak256, stringToHex } from "viem";
import { canonicalSerialize } from "../canonical/serialize.js";
import type { BehaviorSession } from "../session/types.js";
import type { FeatureVector } from "../feature/types.js";
import type { ScoringResult } from "../scorer/types.js";
import { aggregateSessionRoots } from "./aggregateSessionRoots.js";
import { GRADE_INDEX } from "./reportHash.js";
import type { Address, Hex32 } from "./reportHash.js";

export const EVALUATION_REPORT_VERSION = "evaluation-report/1" as const;
export const HASH_SCHEME_V2 = "v2-13field" as const;

export class EvaluationReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationReportError";
  }
}

export interface EvaluatorCodeVersion {
  readonly sdk: string;
  readonly version: string;
  /** git 커밋 40자 hex */
  readonly commit: string;
  /** 작업 트리가 깨끗하지 않으면 true — true면 보고서 생성을 거부한다 */
  readonly dirty: boolean;
}

export interface MissionScope {
  /** 평가 대상 주체(소문자 주소) */
  readonly actor: string;
  /** 미션 대상 컨트랙트(소문자). null이면 대상 제한 없음 */
  readonly targetContracts: readonly string[] | null;
  /** 실패한 TX도 입력에 포함하는가. 누락 탐지에서 불리한 TX 제외를 막기 위해 항상 true를 권장 */
  readonly includeFailed: boolean;
}

export interface EvaluationSessionEntry {
  readonly sessionId: Hex32;
  readonly sessionRoot: Hex32;
  readonly constructionMethod: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly actionCount: number;
  readonly valid: boolean;
  readonly featureValues: {
    readonly efficiency: number;
    readonly stability: number;
    readonly coherence: number;
    readonly riskPattern: number;
    readonly excellence: number;
  };
}

export interface EvaluationReport {
  readonly reportVersion: typeof EVALUATION_REPORT_VERSION;
  readonly chainId: number;
  readonly userAddress: Address;
  readonly missionId: Hex32;
  /** constructSessions에 넘긴 미션 문자열(sessionId 재계산용). missionId(bytes32)에서 역산할 수 없어 별도로 싣는다 */
  readonly missionRef: string;
  readonly ruleSetId: Hex32;
  /** 십진 문자열 */
  readonly referenceBlockNumber: string;
  readonly referenceBlockHash: Hex32;
  /** 평가 구간(블록 번호, 십진 문자열, 양 끝 포함). windowEnd <= referenceBlockNumber */
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly missionScope: MissionScope;
  /** 세션 편입 순서. 파생 액션은 부모 TX 해시로 환원, 최초 등장 순으로 중복 제거 */
  readonly includedTxHashes: readonly Hex32[];
  /**
   * TX별 actionType. 평가 시 어댑터가 쓴 값(탐색기 functionName 기반일 수 있어 RPC만으로는
   * 항상 재도출되지 않는다)을 기록해 두어 검증자가 같은 값으로 세션·특징을 재계산하게 한다.
   */
  readonly txActionTypes: Readonly<Record<string, string>>;
  readonly sessions: readonly EvaluationSessionEntry[];
  /** 세션 sessionRoot 집계값 (온체인 sessionRoot와 같아야 함) */
  readonly sessionRoot: Hex32;
  readonly score: number;
  /** 0~3 (GRADE_INDEX) */
  readonly grade: number;
  readonly evaluatorCodeVersion: EvaluatorCodeVersion;
  /** = 발급 ResultReport.timestamp */
  readonly createdAt: number;
}

/** 공개 보관소 항목(envelope). reportHash(온체인 값)가 키. */
export interface EvaluationReportEnvelope {
  readonly reportHash: Hex32;
  readonly hashScheme: typeof HASH_SCHEME_V2;
  readonly evaluationReport: EvaluationReport;
  readonly evaluationReportHash: Hex32;
  readonly tokenId?: string;
  readonly issueTxHash?: Hex32;
}

const HEX32 = /^0x[0-9a-f]{64}$/;

/** 액션 → 부모 TX 해시. internal/erc20/trace 파생 액션을 TX 단위로 환원한다. */
export function actionToTxHash(actionId: string, domainMetadata?: Readonly<Record<string, unknown>>): Hex32 | null {
  const parent = domainMetadata?.["parentTxHash"];
  if (typeof parent === "string" && HEX32.test(parent.toLowerCase())) return parent.toLowerCase() as Hex32;
  const head = actionId.toLowerCase().split("-")[0] ?? "";
  return HEX32.test(head) ? (head as Hex32) : null;
}

/** 세션 배열(편입 순서)에서 includedTxHashes 추출. */
export function extractIncludedTxHashes(sessions: readonly BehaviorSession[]): Hex32[] {
  const seen = new Set<string>();
  const out: Hex32[] = [];
  for (const s of sessions) {
    for (const a of s.actions) {
      const h = actionToTxHash(a.actionId, a.domainMetadata);
      if (h === null) {
        throw new EvaluationReportError(`action ${a.actionId} is not derivable to a tx hash`);
      }
      if (!seen.has(h)) {
        seen.add(h);
        out.push(h);
      }
    }
  }
  return out;
}

/** TX 해시 → actionType. 파생 액션(internal/erc20)은 부모 TX의 actionType을 덮지 않는다(정상 TX 우선). */
export function extractTxActionTypes(sessions: readonly BehaviorSession[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of sessions) {
    for (const a of s.actions) {
      const h = actionToTxHash(a.actionId, a.domainMetadata);
      if (h === null) continue;
      const isRoot = a.actionId.toLowerCase() === h;
      if (isRoot || out[h] === undefined) out[h] = a.actionType;
    }
  }
  return out;
}

export interface BuildEvaluationReportInput {
  readonly sessions: readonly BehaviorSession[];
  /** sessions와 같은 순서·길이의 특징값 */
  readonly features: readonly FeatureVector[];
  readonly scoring: ScoringResult;
  readonly chainId: number;
  readonly userAddress: Address;
  readonly missionId: Hex32;
  readonly referenceBlockNumber: bigint;
  readonly referenceBlockHash: Hex32;
  readonly windowStart: bigint;
  readonly windowEnd: bigint;
  readonly missionScope: MissionScope;
  readonly evaluatorCodeVersion: EvaluatorCodeVersion;
  /** 발급 ResultReport.timestamp(초) */
  readonly createdAt: bigint;
}

export function buildEvaluationReport(input: BuildEvaluationReportInput): EvaluationReport {
  const { sessions, features } = input;
  if (sessions.length === 0) throw new EvaluationReportError("at least one session required");
  if (features.length !== sessions.length) {
    throw new EvaluationReportError("features length must equal sessions length");
  }
  if (input.evaluatorCodeVersion.dirty) {
    throw new EvaluationReportError("evaluatorCodeVersion.dirty=true — refuse to build a report from an unclean tree");
  }
  if (!/^[0-9a-f]{40}$/.test(input.evaluatorCodeVersion.commit)) {
    throw new EvaluationReportError("evaluatorCodeVersion.commit must be 40 lowercase hex chars");
  }
  if (input.windowStart > input.windowEnd) throw new EvaluationReportError("windowStart > windowEnd");
  if (input.windowEnd > input.referenceBlockNumber) {
    throw new EvaluationReportError("windowEnd must be <= referenceBlockNumber");
  }
  const firstRuleSetId = sessions[0]!.ruleSetId;
  const missionRef = sessions[0]!.missionId;
  const user = input.userAddress.toLowerCase() as Address;
  for (const s of sessions) {
    if (s.ruleSetId !== firstRuleSetId) throw new EvaluationReportError("sessions ruleSetId mismatch");
    if (s.missionId !== missionRef) throw new EvaluationReportError("sessions missionId mismatch");
    if (s.subject !== user) throw new EvaluationReportError("session subject must equal lowercase userAddress");
  }
  const scope: MissionScope = {
    actor: input.missionScope.actor.toLowerCase(),
    targetContracts: input.missionScope.targetContracts === null
      ? null
      : input.missionScope.targetContracts.map((c) => c.toLowerCase()),
    includeFailed: input.missionScope.includeFailed,
  };
  if (scope.actor !== user) throw new EvaluationReportError("missionScope.actor must equal userAddress");

  const entries: EvaluationSessionEntry[] = sessions.map((s, i) => {
    const f = features[i]!;
    return {
      sessionId: s.sessionId,
      sessionRoot: s.sessionRoot,
      constructionMethod: s.constructionMethod,
      startTime: s.startTime,
      endTime: s.endTime,
      actionCount: s.actions.length,
      valid: s.valid,
      featureValues: {
        efficiency: f.efficiency,
        stability: f.stability,
        coherence: f.coherence,
        riskPattern: f.riskPattern,
        excellence: f.excellence,
      },
    };
  });

  return {
    reportVersion: EVALUATION_REPORT_VERSION,
    chainId: input.chainId,
    userAddress: user,
    missionId: input.missionId.toLowerCase() as Hex32,
    missionRef,
    ruleSetId: firstRuleSetId.toLowerCase() as Hex32,
    referenceBlockNumber: input.referenceBlockNumber.toString(10),
    referenceBlockHash: input.referenceBlockHash.toLowerCase() as Hex32,
    windowStart: input.windowStart.toString(10),
    windowEnd: input.windowEnd.toString(10),
    missionScope: scope,
    includedTxHashes: extractIncludedTxHashes(sessions),
    txActionTypes: extractTxActionTypes(sessions),
    sessions: entries,
    sessionRoot: aggregateSessionRoots(sessions).toLowerCase() as Hex32,
    score: Math.round(input.scoring.score),
    grade: GRADE_INDEX[input.scoring.grade],
    evaluatorCodeVersion: input.evaluatorCodeVersion,
    createdAt: Number(input.createdAt),
  };
}

/** evaluationReportHash = keccak256(utf8(canonicalSerialize(report))) */
export function computeEvaluationReportHash(report: EvaluationReport): Hex32 {
  return keccak256(stringToHex(canonicalSerialize(report)));
}

export function toEnvelope(
  report: EvaluationReport,
  reportHash: Hex32,
  extra?: { tokenId?: string; issueTxHash?: Hex32 },
): EvaluationReportEnvelope {
  return {
    reportHash,
    hashScheme: HASH_SCHEME_V2,
    evaluationReport: report,
    evaluationReportHash: computeEvaluationReportHash(report),
    ...(extra?.tokenId !== undefined ? { tokenId: extra.tokenId } : {}),
    ...(extra?.issueTxHash !== undefined ? { issueTxHash: extra.issueTxHash } : {}),
  };
}
