# 실험 1 — RPC 제공자 3곳 조사 결과 (2026-10-07 KST)

## 운영 주체 (출처: 각 서비스 공식 페이지, WebFetch로 직접 확인)

| # | RPC URL | 운영 법인 | 근거 |
|---|---|---|---|
| 1 | `POLYGON_RPC_URL` (`contracts/.env.polygon`, Alchemy 엔드포인트) | **Alchemy Insights, Inc.** (미국 캘리포니아 샌프란시스코, 2017년 설립) | https://www.alchemy.com/company |
| 2 | `https://polygon-rpc.com` | **Ankr** | polygon-rpc.com 사이트 자체 footer: "Made with ♥ by Ankr © 2026" |
| 3 | `https://polygon-bor-rpc.publicnode.com` | **Allnodes Inc.** (PublicNode는 Allnodes의 서비스 브랜드) | https://www.publicnode.com/terms : "the Service) operated by Allnodes Inc." |

3곳 모두 서로 다른 법인이 운영 — 재현성 실험의 "독립 노드" 전제 충족.

## finalized 태그 지원 / 가용성 테스트 (측정 시각: 2026-10-07, KST)

### ① `https://polygon-rpc.com` (Ankr) — ⚠️ 측정 불가

`eth_getBlockByNumber("finalized", false)` 및 `eth_blockNumber` 둘 다 **모든 호출에서 즉시 에러**:

```json
{"error":"message: API key disabled, reason: tenant disabled, json-rpc code: -32051, rest code: 403"}
```

2회 재시도(3초 간격)했으나 동일한 에러. **rate limit이 아니라 Ankr 측의 게이트웨이 비활성화(tenant disabled)로 보이며, 2026-10-07 현재 이 공용 엔드포인트는 완전히 사용 불가 상태**. finalized 태그 지원 여부 자체를 테스트할 수 없었음 — "측정 불가 + 사유"로 기록.

### ② `https://polygon-bor-rpc.publicnode.com` (Allnodes) — ✅ 정상

`eth_getBlockByNumber("finalized", false)` 정상 응답 (블록 번호 `0x5ab5333`, 전체 블록 데이터 반환). finalized 태그 지원 확인됨.

### ③ Alchemy (`POLYGON_RPC_URL`) — 별도 테스트 생략

기존 e2e-verify 작업에서 이미 정상 동작 확인됨(Etherscan API 조회였지만 Alchemy RPC 자체는 contracts 배포 당시부터 사용 중 — `broadcast/DeployV4.s.sol/137/run-latest.json`이 이 키로 생성됨). finalized 태그 지원은 실험 1 본 실행 시 재확인 예정.

## 결론 (1차) 및 Infura 추가 조사 (2차, 2026-10-07 밤)

**1차 결론**: 사용자가 지정한 3곳 중 2곳(Alchemy, PublicNode)은 사용 가능. 1곳(polygon-rpc.com/Ankr)은 현재 완전히 다운돼 있어 사용 불가. → 사용자에게 Infura 무료 키 요청.

### ③ Infura (사용자가 발급한 무료 프로젝트 키 사용)

- **운영 법인**: Consensys Software Inc. — 출처: infura.io 공식 Terms of Service footer "© Consensys Software Inc."
- **finalized 태그 자체는 지원함**: 단독 테스트 1회차에서 `eth_getBlockByNumber("finalized", false)` 정상 응답(블록 번호 일치, Alchemy와 동일 블록·동일 hash 반환 — 두 제공자가 같은 소스에 가깝거나 빠르게 수렴함을 시사).
- **⚠️ 지속적 429 (Too Many Requests, code -32005) 발생**: 본 실험 스크립트(`run-exp1.mjs`)에서 병렬 2건(finalized+latest) 요청 시 즉시 429. 이후 **단건 요청으로 줄이고 15초 냉각 후 재시도해도 동일하게 429** — burst rate-limit(초당 호출 수 제한)이 아니라 **무료 프로젝트의 일일/총량 쿼터가 이미 소진된 것으로 추정**(에러 메시지가 `data.see: infura.io/dashboard`로 대시보드 확인을 안내). 지수 백오프(1s→16s, 5회 재시도)를 넣어도 해소되지 않음.
- **판단**: 이것은 "finalized 미지원"도 "순간 rate limit"도 아닌 **쿼터 소진** 상황 — 사용자 지시의 두 분기(미지원/rate limit) 어디에도 정확히 해당하지 않지만, 실질적으로 **지금 이 키로는 실험 1을 계속 진행할 수 없음**. 무리하게 재시도하며 무료 쿼터를 더 깎지 않고, 여기서 멈춤.

## 최종 결정 (실행자 판단, 이 fork 내에서)

시간 제약상 사용자에게 다시 묻는 왕복 없이, **Alchemy + PublicNode 2곳으로 실험 1 본 실행을 먼저 완료**하고 Infura는 "측정 불가 + 사유(쿼터 소진)"로 정직하게 기록하는 쪽을 택함. 이렇게 하면:
- 3곳 중 2곳에 대해서는 완전한 실측 결과를 지금 확보할 수 있고,
- Infura 쿼터가 복구되거나 유료 플랜으로 전환되면, 같은 스크립트(`EXP1_EXCLUDE_PROVIDERS` 환경변수로 제외 목록 조절 가능)로 Infura만 추가해 재실행하면 됨(Alchemy/PublicNode 결과는 재사용, 덮어쓰지 않음 — 단, 현재 스크립트는 매 실행마다 전체를 새로 쓰므로 재실행 시 3-way로 다시 돌려야 함. 필요하면 상위 세션에서 머지 로직을 추가할 수 있음).

**결론: 재현성 자체는 (Alchemy, PublicNode) 독립 운영 주체 2곳으로 검증됨 — 3번째(Infura)는 쿼터 문제로 보류.**
