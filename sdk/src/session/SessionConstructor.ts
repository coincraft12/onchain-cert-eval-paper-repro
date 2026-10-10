/**
 * SessionConstructor (130) — 특허 C-1 §3-2.
 *
 * 정규화된 액션 배열 → BehaviorSession[] (경계 규칙에 따라 여러 세션으로 분할될 수 있음).
 *
 * 지원 방식 (whitepaper §3-2 우선순위):
 *   - 132 boundary-events (부분): 특정 actionType 등장 시 세션 종료
 *   - 134 state-machine: 미리 정의된 상태 전이 그래프 준수 여부
 *   - 135 tx-dag: parentActions 그래프의 연결 성분이 세션
 *   - 133 similarity-graph: 액션 쌍 유사도 임계치 이상이면 같은 세션 (부정행위·담합 감지에도 활용)
 *   - 131 time-timeout: 활동 간격 > timeoutSeconds → 세션 종료 (fallback)
 *   - "combined": 순차 방식(131+132+134) OR 병합. 133·135 는 분할 방식이라 combined 대상 아님
 *
 * 결정성: 어떤 method든 같은 입력 → 같은 세션 배열 → 같은 sessionRoot·sessionId.
 */

import { keccak256, stringToHex } from "viem";
import { canonicalSerialize } from "../canonical/serialize.js";
import type { NormalizedAction } from "../collection/types.js";
import type {
  SessionBoundaryRule,
  SimilarityRule,
  SimilarityWeights,
  StateMachineRule,
} from "../ruleset/types.js";
import { computeSessionRoot } from "./computeSessionRoot.js";
import type { BehaviorSession, Hex32, SessionConstructionMethod } from "./types.js";

export class SessionConstructorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionConstructorError";
  }
}

export interface ConstructSessionsParams {
  readonly actions: readonly NormalizedAction[];
  readonly rule: SessionBoundaryRule;
  readonly subject: string;
  readonly missionId: string;
  readonly ruleSetId: Hex32;
  readonly chainId?: number;
  readonly referenceBlockNumber?: bigint;
  /** 경계 결정 방식. 기본 "combined" (131+132+134 OR 병합) */
  readonly method?: SessionConstructionMethod;
}

const SUPPORTED: readonly SessionConstructionMethod[] = [
  "time-timeout",
  "boundary-events",
  "state-machine",
  "tx-dag",
  "similarity-graph",
  "combined",
];

// ---------- Public entry ----------

export function constructSessions(
  params: ConstructSessionsParams,
): readonly BehaviorSession[] {
  const method = params.method ?? "combined";
  if (!SUPPORTED.includes(method)) {
    throw new SessionConstructorError(`unknown method: ${method}`);
  }
  if (params.rule.timeoutSeconds < 0) {
    throw new SessionConstructorError(
      `rule.timeoutSeconds must be >= 0 (got ${params.rule.timeoutSeconds})`,
    );
  }
  if (method === "state-machine" && !params.rule.stateMachine) {
    throw new SessionConstructorError(
      "method=state-machine requires rule.stateMachine",
    );
  }
  if (method === "similarity-graph" && !params.rule.similarityRule) {
    throw new SessionConstructorError(
      "method=similarity-graph requires rule.similarityRule",
    );
  }

  // finalized=true 만 세션화 대상 (§3-2 결정성 조건 2)
  const eligible = params.actions.filter((a) => a.finalized);
  if (eligible.length === 0) return [];

  let bucketed: BucketedResult;
  switch (method) {
    case "tx-dag":
      bucketed = {
        buckets: bucketByDag(eligible),
        extraViolations: [],
        reachedTerminals: [],
      };
      break;
    case "similarity-graph":
      bucketed = {
        buckets: bucketBySimilarity(eligible, params.rule.similarityRule!),
        extraViolations: [],
        reachedTerminals: [],
      };
      break;
    // 순차 방식
    case "time-timeout":
    case "boundary-events":
    case "state-machine":
    case "combined":
      bucketed = bucketSequential(eligible, params.rule, method);
      break;
  }

  const minCount = params.rule.minActionCount ?? 1;
  return bucketed.buckets.map((actions, idx) => {
    const extra = bucketed.extraViolations[idx];
    const term = bucketed.reachedTerminals[idx];
    return buildSession({
      actions,
      subject: params.subject,
      missionId: params.missionId,
      ruleSetId: params.ruleSetId,
      method,
      minCount,
      ...(extra !== undefined ? { extraViolations: extra } : {}),
      ...(term !== undefined ? { reachedTerminal: term } : {}),
      ...(params.chainId !== undefined ? { chainId: params.chainId } : {}),
      ...(params.referenceBlockNumber !== undefined
        ? { referenceBlockNumber: params.referenceBlockNumber }
        : {}),
    });
  });
}

// ---------- Sequential bucketing (131 + 132 + 134 + combined) ----------

interface BucketedResult {
  readonly buckets: readonly (readonly NormalizedAction[])[];
  /** 각 버킷별 추가 위반 (state-machine invalid transition 등) */
  readonly extraViolations: readonly (readonly string[] | undefined)[];
  /** 각 버킷별 terminal 도달 여부 (state-machine · combined 만) */
  readonly reachedTerminals: readonly (boolean | undefined)[];
}

function bucketSequential(
  actions: readonly NormalizedAction[],
  rule: SessionBoundaryRule,
  method: SessionConstructionMethod,
): BucketedResult {
  const useTimeout = method === "time-timeout" || method === "combined";
  const useBoundary =
    (method === "boundary-events" || method === "combined") &&
    !!rule.boundaryActionTypes &&
    rule.boundaryActionTypes.length > 0;
  const useStateMachine =
    (method === "state-machine" || method === "combined") && !!rule.stateMachine;

  const boundarySet = new Set(rule.boundaryActionTypes ?? []);
  const sm = rule.stateMachine;
  const transitionMap = sm ? buildTransitionMap(sm) : null;

  const buckets: NormalizedAction[][] = [];
  const violations: (string[] | undefined)[] = [];
  const reachedTerminals: (boolean | undefined)[] = [];
  let bucket: NormalizedAction[] = [];
  let bucketViolations: string[] = [];
  let bucketReachedTerminal = false;
  let currentState = sm?.initialState ?? "";
  let prev: NormalizedAction | null = null;

  const flush = () => {
    if (bucket.length > 0) {
      buckets.push(bucket);
      violations.push(bucketViolations.length > 0 ? [...bucketViolations] : undefined);
      reachedTerminals.push(useStateMachine ? bucketReachedTerminal : undefined);
      bucket = [];
      bucketViolations = [];
      bucketReachedTerminal = false;
      if (sm) currentState = sm.initialState;
    }
  };

  for (const a of actions) {
    // 순차 경계 판정 (timeout / boundary events) — bucket 이전에 break
    let breakBefore = false;
    if (prev !== null) {
      if (useTimeout && a.timestamp - prev.timestamp > rule.timeoutSeconds) {
        breakBefore = true;
      }
      if (useBoundary && boundarySet.has(a.actionType)) {
        breakBefore = true;
      }
    }
    if (breakBefore) flush();

    // 상태 머신 판정 (134)
    if (useStateMachine && sm && transitionMap) {
      const nextState = transitionMap.get(transitionKey(currentState, a.actionType));
      if (nextState !== undefined) {
        bucket.push(a);
        currentState = nextState;
        // terminal 도달 시 플래그 → 세션 강제 마감
        if (sm.terminalStates.includes(currentState)) {
          bucketReachedTerminal = true;
          flush();
        }
      } else {
        // 허용 안 되는 전이
        switch (sm.invalidTransitionPolicy) {
          case "new-session":
            // 세션 종료 후 새 세션에서 initialState 로 재시도
            flush();
            currentState = sm.initialState;
            const retry = transitionMap.get(transitionKey(currentState, a.actionType));
            if (retry !== undefined) {
              bucket.push(a);
              currentState = retry;
              if (sm.terminalStates.includes(currentState)) {
                bucketReachedTerminal = true;
                flush();
              }
            } else {
              bucket.push(a);
              bucketViolations.push(
                `invalid initial transition: ${currentState} -[${a.actionType}]-> ?`,
              );
            }
            break;
          case "mark-violation":
            bucket.push(a);
            bucketViolations.push(
              `invalid transition: ${currentState} -[${a.actionType}]-> ?`,
            );
            break;
          case "reject-action":
            // 액션을 세션에 편입하지 않음 (감사 흔적 = stepViolations)
            bucketViolations.push(
              `rejected action ${a.actionId}: ${currentState} -[${a.actionType}]-> ?`,
            );
            break;
        }
      }
    } else {
      bucket.push(a);
    }

    prev = a;
  }
  flush();

  return { buckets, extraViolations: violations, reachedTerminals };
}

function transitionKey(from: string, actionType: string): string {
  return `${from}\x00${actionType}`;
}

function buildTransitionMap(sm: StateMachineRule): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of sm.transitions) {
    m.set(transitionKey(t.from, t.actionType), t.to);
  }
  return m;
}

// ---------- DAG bucketing (135) ----------

function bucketByDag(
  actions: readonly NormalizedAction[],
): readonly (readonly NormalizedAction[])[] {
  const n = actions.length;
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < n; i++) idToIdx.set(actions[i]!.actionId, i);

  const uf = new UnionFind(n);
  for (let i = 0; i < n; i++) {
    const a = actions[i]!;
    if (!a.parentActions) continue;
    for (const parentId of a.parentActions) {
      const j = idToIdx.get(parentId);
      if (j !== undefined) uf.union(i, j);
    }
  }

  return groupByComponent(actions, uf);
}

// ---------- Similarity bucketing (133) ----------

function bucketBySimilarity(
  actions: readonly NormalizedAction[],
  rule: SimilarityRule,
): readonly (readonly NormalizedAction[])[] {
  if (rule.threshold < 0 || rule.threshold > 1) {
    throw new SessionConstructorError(
      `similarityRule.threshold out of [0,1]: ${rule.threshold}`,
    );
  }
  const totalWeight =
    rule.weights.functionSelector +
    rule.weights.eventSignature +
    rule.weights.failureType +
    rule.weights.stateKeyOverlap +
    rule.weights.contractIdentity;
  if (totalWeight <= 0) {
    throw new SessionConstructorError("similarityRule.weights sum must be > 0");
  }

  const n = actions.length;
  const uf = new UnionFind(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const raw = pairSimilarity(actions[i]!, actions[j]!, rule.weights);
      const norm = raw / totalWeight;
      if (norm >= rule.threshold) uf.union(i, j);
    }
  }

  return groupByComponent(actions, uf);
}

/**
 * whitepaper §3-2 원문 유사도 5특성. C-1 무관성 관점의 예외 지점:
 *   - 3~5 는 domainMetadata 를 참조 (state key / contract 동일성 등).
 *   - 이 예외는 133 을 rule 로 활성화한 경우에만 발동 — opt-in.
 *   - 어댑터가 domainMetadata 에 `to`/`contractAddress` 를 넣지 않으면 해당 특성 기여도 0.
 */
function pairSimilarity(
  a: NormalizedAction,
  b: NormalizedAction,
  w: SimilarityWeights,
): number {
  let sum = 0;
  // 1. function selector = actionType 정확 매칭
  if (a.actionType === b.actionType) sum += w.functionSelector;
  // 2. event signature = 첫 parentActions 동일
  const aP = a.parentActions?.[0];
  const bP = b.parentActions?.[0];
  if (aP !== undefined && aP === bP) sum += w.eventSignature;
  // 3. 실패 유형 = status 동일
  if (a.status === b.status) sum += w.failureType;
  // 4. state key 겹침 (근사): domainMetadata.to 동일
  const aTo = getStringField(a.domainMetadata, "to");
  const bTo = getStringField(b.domainMetadata, "to");
  if (aTo !== undefined && aTo === bTo) sum += w.stateKeyOverlap;
  // 5. 호출 대상 컨트랙트 동일성: domainMetadata.contractAddress or fallback to
  const aC = getStringField(a.domainMetadata, "contractAddress") ?? aTo;
  const bC = getStringField(b.domainMetadata, "contractAddress") ?? bTo;
  if (aC !== undefined && aC === bC) sum += w.contractIdentity;
  return sum;
}

function getStringField(
  md: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const v = md[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// ---------- shared: group by UnionFind components + deterministic order ----------

function groupByComponent(
  actions: readonly NormalizedAction[],
  uf: UnionFind,
): readonly (readonly NormalizedAction[])[] {
  const groups = new Map<number, NormalizedAction[]>();
  for (let i = 0; i < actions.length; i++) {
    const root = uf.find(i);
    let g = groups.get(root);
    if (!g) {
      g = [];
      groups.set(root, g);
    }
    g.push(actions[i]!);
  }

  const sortActions = (a: NormalizedAction, b: NormalizedAction) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.actionId < b.actionId) return -1;
    if (a.actionId > b.actionId) return 1;
    return 0;
  };

  // 그룹 내부 결정적 정렬 (분할 방식은 셔플 입력도 안전해야 함)
  for (const g of groups.values()) g.sort(sortActions);

  // 그룹 간 정렬: 첫 원소의 (timestamp, actionId)
  const list = Array.from(groups.values());
  list.sort((x, y) => sortActions(x[0]!, y[0]!));
  return list;
}

class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0) as number[];
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root]! !== root) root = this.parent[root]!;
    // path compression
    let cur = x;
    while (this.parent[cur]! !== root) {
      const next = this.parent[cur]!;
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra]! < this.rank[rb]!) {
      this.parent[ra] = rb;
    } else if (this.rank[ra]! > this.rank[rb]!) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra] = this.rank[ra]! + 1;
    }
  }
}

// ---------- BehaviorSession assembly ----------

interface BuildSessionParams {
  readonly actions: readonly NormalizedAction[];
  readonly subject: string;
  readonly missionId: string;
  readonly ruleSetId: Hex32;
  readonly method: SessionConstructionMethod;
  readonly minCount: number;
  readonly chainId?: number;
  readonly referenceBlockNumber?: bigint;
  readonly extraViolations?: readonly string[];
  readonly reachedTerminal?: boolean;
}

function buildSession(p: BuildSessionParams): BehaviorSession {
  const first = p.actions[0]!;
  const last = p.actions[p.actions.length - 1]!;
  const sessionRoot = computeSessionRoot(p.actions);
  const belowMin = p.actions.length < p.minCount;
  const violations: string[] = [];
  if (belowMin) {
    violations.push(
      `actionCount(${p.actions.length}) < minActionCount(${p.minCount})`,
    );
  }
  if (p.extraViolations && p.extraViolations.length > 0) {
    violations.push(...p.extraViolations);
  }
  const valid = violations.length === 0;

  const sessionId = computeSessionId({
    subject: p.subject,
    missionId: p.missionId,
    ruleSetId: p.ruleSetId,
    startTime: first.timestamp,
    endTime: last.timestamp,
    sessionRoot,
  });

  const base: BehaviorSession = {
    sessionId,
    subject: p.subject,
    missionId: p.missionId,
    ruleSetId: p.ruleSetId,
    constructionMethod: p.method,
    actions: p.actions,
    startTime: first.timestamp,
    endTime: last.timestamp,
    sessionRoot,
    valid,
  };

  return {
    ...base,
    ...(p.chainId !== undefined ? { chainId: p.chainId } : {}),
    ...(p.referenceBlockNumber !== undefined
      ? { referenceBlockNumber: p.referenceBlockNumber }
      : {}),
    ...(violations.length > 0 ? { stepViolations: violations } : {}),
    ...(p.reachedTerminal !== undefined
      ? { reachedTerminal: p.reachedTerminal }
      : {}),
  };
}

/**
 * sessionId = keccak256(canonicalSerialize({ subject, missionId, ruleSetId, startTime, endTime, sessionRoot })).
 * sessionRoot 이 이미 액션 배열에 결정성으로 의존하므로 sessionId 도 동일 입력 → 동일 값.
 */
export function computeSessionId(inputs: {
  subject: string;
  missionId: string;
  ruleSetId: Hex32;
  startTime: number;
  endTime: number;
  sessionRoot: Hex32;
}): Hex32 {
  const canonical = canonicalSerialize({
    subject: inputs.subject,
    missionId: inputs.missionId,
    ruleSetId: inputs.ruleSetId,
    startTime: inputs.startTime,
    endTime: inputs.endTime,
    sessionRoot: inputs.sessionRoot,
  });
  return keccak256(stringToHex(canonical));
}
