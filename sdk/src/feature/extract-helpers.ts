/**
 * FeatureExtractor 공용 헬퍼.
 */

import type { EvidenceMappingRule, FeatureWeights } from "../ruleset/types.js";
import type { BehaviorSession } from "../session/types.js";
import type { EvidencePointer, FeatureKey } from "./types.js";

/** 값을 [0, 1] 로 잘라내기. NaN/Infinity → 0. */
export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * RuleSet.evidenceMapping 이 있으면, 특정 feature 에 대한 actionType 기여도를
 * evidence 배열에 부여. (특성 값 자체 보정은 각 extractor 재량으로 별도 처리)
 */
export function applyEvidenceMapping(
  session: BehaviorSession,
  mapping: readonly EvidenceMappingRule[] | undefined,
  feature: FeatureKey,
  evidence: EvidencePointer[],
): void {
  if (!mapping || mapping.length === 0) return;
  const contribByType = new Map<string, number>();
  for (const rule of mapping) {
    const c = rule.contributions[feature];
    if (c !== undefined && c !== 0) contribByType.set(rule.actionType, c);
  }
  if (contribByType.size === 0) return;
  for (let i = 0; i < session.actions.length; i++) {
    const a = session.actions[i]!;
    const c = contribByType.get(a.actionType);
    if (c !== undefined) {
      evidence.push({
        feature,
        sessionId: session.sessionId,
        actionIndex: i,
        actionId: a.actionId,
        weight: c,
        reason: `evidenceMapping:${a.actionType}`,
      });
    }
  }
}

/**
 * absencePenalty 적용 — 특정 actionType 이 세션에 없으면 각 feature 감점.
 *
 * 부정행위 감지 (예: `transferOwnership` 없음 = Timelock 우회 → riskPattern 감점).
 * 감점 후 [0, 1] 범위 clamp. evidence 에도 pointer 추가 (감사 근거).
 *
 * @returns 조정된 feature 값 + 추가된 evidence
 */
export function applyAbsencePenalties(
  session: BehaviorSession,
  mapping: readonly EvidenceMappingRule[] | undefined,
  values: {
    efficiency: number;
    stability: number;
    coherence: number;
    riskPattern: number;
    excellence: number;
  },
): {
  readonly values: {
    readonly efficiency: number;
    readonly stability: number;
    readonly coherence: number;
    readonly riskPattern: number;
    readonly excellence: number;
  };
  readonly evidence: readonly EvidencePointer[];
} {
  if (!mapping || mapping.length === 0) {
    return { values, evidence: [] };
  }
  // 세션에 등장한 actionType 집합
  const present = new Set(session.actions.map((a) => a.actionType));
  const adjusted = { ...values };
  const evidence: EvidencePointer[] = [];

  for (const rule of mapping) {
    if (!rule.absencePenalty) continue;
    if (present.has(rule.actionType)) continue; // 등장했음 → 감점 없음

    const features: (keyof FeatureWeights)[] = [
      "efficiency",
      "stability",
      "coherence",
      "riskPattern",
      "excellence",
    ];
    for (const f of features) {
      const p = rule.absencePenalty[f];
      if (p === undefined || p === 0) continue;
      const before = adjusted[f];
      const after = clamp01(before - p);
      adjusted[f] = after;
      evidence.push({
        feature: f,
        sessionId: session.sessionId,
        actionIndex: -1, // 액션 없음 표시
        actionId: `absence:${rule.actionType}`,
        weight: -p,
        reason: `absence:${rule.actionType}`,
      });
    }
  }

  return { values: adjusted, evidence };
}

/**
 * stepViolations 페널티 — 세션의 state machine 위반 수 만큼 감점.
 *
 * 반영 특성 (2026-07-06 tuning v2):
 *   - coherence -0.15/violation (순서 미준수는 계획성 부재)
 *   - riskPattern -0.15/violation (기대 절차 이탈은 큰 리스크)
 *   - excellence -0.05/violation (우수성 감소)
 *
 * whitepaper §3-2 134 state-machine 결과를 실제 스코어에 반영. Adversarial testing 발견 (reorder 시나리오).
 * 4~5 violations 시 features 대부분 0 근처로 → Below 정확 배정.
 */
export function applyStepViolationsPenalty(
  session: BehaviorSession,
  values: {
    efficiency: number;
    stability: number;
    coherence: number;
    riskPattern: number;
    excellence: number;
  },
): {
  readonly values: {
    readonly efficiency: number;
    readonly stability: number;
    readonly coherence: number;
    readonly riskPattern: number;
    readonly excellence: number;
  };
  readonly evidence: readonly EvidencePointer[];
} {
  const violations = session.stepViolations?.length ?? 0;
  if (violations === 0) {
    return { values, evidence: [] };
  }
  // 2026-07-06 tuning v3: additive + 4+ 위반 시 multiplicative × 0.5 (heavy adversarial)
  const cohPenalty = 0.10 * violations;
  const riskPenalty = 0.08 * violations;
  const excPenalty = 0.03 * violations;
  // Additive 감점 후
  const afterAdditive = {
    efficiency: values.efficiency,
    stability: values.stability,
    coherence: clamp01(values.coherence - cohPenalty),
    riskPattern: clamp01(values.riskPattern - riskPenalty),
    excellence: clamp01(values.excellence - excPenalty),
  };
  const evidence: EvidencePointer[] = [
    {
      feature: "coherence",
      sessionId: session.sessionId,
      actionIndex: -1,
      actionId: `stepViolations:${violations}`,
      weight: -cohPenalty,
      reason: `stepViolations:${violations}`,
    },
    {
      feature: "riskPattern",
      sessionId: session.sessionId,
      actionIndex: -1,
      actionId: `stepViolations:${violations}`,
      weight: -riskPenalty,
      reason: `stepViolations:${violations}`,
    },
    {
      feature: "excellence",
      sessionId: session.sessionId,
      actionIndex: -1,
      actionId: `stepViolations:${violations}`,
      weight: -excPenalty,
      reason: `stepViolations:${violations}`,
    },
  ];

  // 4+ 위반 시 multiplicative × 0.5 (heavy adversarial detection)
  if (violations >= 4) {
    const multiplier = 0.5;
    const adjusted = {
      efficiency: clamp01(afterAdditive.efficiency * multiplier),
      stability: clamp01(afterAdditive.stability * multiplier),
      coherence: clamp01(afterAdditive.coherence * multiplier),
      riskPattern: clamp01(afterAdditive.riskPattern * multiplier),
      excellence: clamp01(afterAdditive.excellence * multiplier),
    };
    for (const f of ["efficiency", "stability", "coherence", "riskPattern", "excellence"] as const) {
      evidence.push({
        feature: f,
        sessionId: session.sessionId,
        actionIndex: -1,
        actionId: `stepViolations:${violations}:multiplicative`,
        weight: -(1 - multiplier),
        reason: `heavyViolations:${violations}>=4`,
      });
    }
    return { values: adjusted, evidence };
  }

  return { values: afterAdditive, evidence };
}

/**
 * Terminal 도달 보너스 — state machine 완주 시 coherence·excellence 상승.
 *
 * whitepaper §3-2 134: 완주 = 요구 절차 이해 완료. Perfect 시나리오가 Professional
 * 임계치에 도달하려면 이 보너스가 필요 (base coherence max ~0.7).
 */
export function applyTerminalReachedBonus(
  session: BehaviorSession,
  values: {
    efficiency: number;
    stability: number;
    coherence: number;
    riskPattern: number;
    excellence: number;
  },
): {
  readonly values: {
    readonly efficiency: number;
    readonly stability: number;
    readonly coherence: number;
    readonly riskPattern: number;
    readonly excellence: number;
  };
  readonly evidence: readonly EvidencePointer[];
} {
  if (session.reachedTerminal !== true) {
    return { values, evidence: [] };
  }
  const cohBonus = 0.15;
  const excBonus = 0.10;
  const adjusted = {
    efficiency: values.efficiency,
    stability: values.stability,
    coherence: clamp01(values.coherence + cohBonus),
    riskPattern: values.riskPattern,
    excellence: clamp01(values.excellence + excBonus),
  };
  const evidence: EvidencePointer[] = [
    {
      feature: "coherence",
      sessionId: session.sessionId,
      actionIndex: -1,
      actionId: "reachedTerminal",
      weight: cohBonus,
      reason: "reachedTerminal",
    },
    {
      feature: "excellence",
      sessionId: session.sessionId,
      actionIndex: -1,
      actionId: "reachedTerminal",
      weight: excBonus,
      reason: "reachedTerminal",
    },
  ];
  return { values: adjusted, evidence };
}

/**
 * Human pace penalty — bot 감지 (인간 반응 시간 signal).
 *
 * 액션 간 평균 간격이 인간 반응 한계 이하면 스크립트 자동화 의심.
 *
 * 3단계 감점:
 *   - avg interval >= 60s: 감점 없음 (인간 페이스)
 *   - 15s <= avg < 60s: coh -0.20, risk -0.20 (빠르지만 가능)
 *   - avg < 15s: multiplicative × 0.4 (bot 확실 · 큰 감점)
 */
export function applyHumanPacePenalty(
  session: BehaviorSession,
  values: {
    efficiency: number;
    stability: number;
    coherence: number;
    riskPattern: number;
    excellence: number;
  },
): {
  readonly values: {
    readonly efficiency: number;
    readonly stability: number;
    readonly coherence: number;
    readonly riskPattern: number;
    readonly excellence: number;
  };
  readonly evidence: readonly EvidencePointer[];
} {
  const n = session.actions.length;
  if (n < 2) return { values, evidence: [] };
  const totalSpan = session.endTime - session.startTime;
  const avgInterval = totalSpan / (n - 1);

  if (avgInterval >= 60) return { values, evidence: [] };

  const isBotLike = avgInterval < 15;
  const evidence: EvidencePointer[] = [];

  if (isBotLike) {
    const multiplier = 0.4;
    const adjusted = {
      efficiency: clamp01(values.efficiency * multiplier),
      stability: clamp01(values.stability * multiplier),
      coherence: clamp01(values.coherence * multiplier),
      riskPattern: clamp01(values.riskPattern * multiplier),
      excellence: clamp01(values.excellence * multiplier),
    };
    for (const f of ["efficiency", "stability", "coherence", "riskPattern", "excellence"] as const) {
      evidence.push({
        feature: f,
        sessionId: session.sessionId,
        actionIndex: -1,
        actionId: `humanPace:avgInterval=${avgInterval.toFixed(1)}s`,
        weight: -(1 - multiplier),
        reason: `botLike:avgInterval<15s`,
      });
    }
    return { values: adjusted, evidence };
  }

  const cohPenalty = 0.20;
  const riskPenalty = 0.20;
  const adjusted = {
    efficiency: values.efficiency,
    stability: values.stability,
    coherence: clamp01(values.coherence - cohPenalty),
    riskPattern: clamp01(values.riskPattern - riskPenalty),
    excellence: values.excellence,
  };
  evidence.push(
    {
      feature: "coherence",
      sessionId: session.sessionId,
      actionIndex: -1,
      actionId: `humanPace:avgInterval=${avgInterval.toFixed(1)}s`,
      weight: -cohPenalty,
      reason: `rapidPace:avgInterval<60s`,
    },
    {
      feature: "riskPattern",
      sessionId: session.sessionId,
      actionIndex: -1,
      actionId: `humanPace:avgInterval=${avgInterval.toFixed(1)}s`,
      weight: -riskPenalty,
      reason: `rapidPace:avgInterval<60s`,
    },
  );
  return { values: adjusted, evidence };
}
