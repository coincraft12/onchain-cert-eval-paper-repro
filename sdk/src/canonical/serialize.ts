/**
 * Canonical JSON serialization — JCS (RFC 8785) 부분 구현.
 *
 * 동일 입력 → 동일 바이트 출력을 보장한다. 이 결정성이 `ruleSetId`와
 * `reportHash` 두 핵심 불변식의 기반이다 (특허 C-1 §6-1).
 *
 * 규칙:
 *   1. 객체 키를 UTF-16 code unit 사전순 정렬
 *   2. 공백 제거
 *   3. 숫자는 ECMA-262 toString (NaN/Infinity 거부)
 *   4. bigint은 십진 문자열로 변환 (앞에 "n" 접미사 없음)
 *   5. undefined/function/symbol 필드는 거부 (silent drop 안 함)
 *   6. UTF-8 인코딩
 */

export class CanonicalSerializeError extends Error {
  constructor(message: string, readonly path: string[]) {
    super(`${message} at path: ${path.join(".") || "<root>"}`);
    this.name = "CanonicalSerializeError";
  }
}

type Json =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly Json[]
  | { readonly [k: string]: Json };

export function canonicalSerialize(value: unknown): string {
  return serialize(value, []);
}

export function canonicalSerializeBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalSerialize(value));
}

function serialize(value: unknown, path: string[]): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value); // ECMA-262 string escape
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalSerializeError(`non-finite number (${value})`, path);
    }
    // ECMA-262 toString — Number.toString()이 그 자체로 ECMA-262 7.1.12 따름
    return value === 0 ? "0" : value.toString();
  }
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) {
    const parts = value.map((v, i) => serialize(v, [...path, String(i)]));
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(compareUtf16);
    const parts = keys.map((k) => {
      const v = obj[k];
      if (v === undefined) {
        throw new CanonicalSerializeError(`undefined field (${k})`, path);
      }
      return `${JSON.stringify(k)}:${serialize(v, [...path, k])}`;
    });
    return `{${parts.join(",")}}`;
  }
  throw new CanonicalSerializeError(`unsupported type (${typeof value})`, path);
}

/** UTF-16 code unit 사전순 비교 — JCS 5.1 요구사항. */
function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type { Json };
