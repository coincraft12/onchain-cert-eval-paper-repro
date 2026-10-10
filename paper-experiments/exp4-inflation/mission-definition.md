# 실험 4 — 미션 정의 (FORK-MISSION-1)

> 구현 전 먼저 문서화한다(논문 세션 지시 준수). 실측은 이 문서 확정 후 진행.

## 환경

- **Polygon 메인넷 로컬 포크** (`anvil --fork-url <Alchemy Polygon RPC> --port 8546 --chain-id 137`)
- 포크 시점 블록: `#95,189,290` (2026-10-10 KST 기동 시점의 실제 체인 최신 블록 상태를 그대로 복제)
- 비용 0 (가스비 실비용 없음, anvil 테스트 계정에 `anvil_setBalance`로 가상 POL 지급)
- 실제 메인넷에 배포된 **진짜 컨트랙트 바이트코드·상태**(WMATIC, QuickSwap V2 Router)를 대상으로 TX를 실행 — 합성 컨트랙트 아님
- 지갑: `anvil_impersonateAccount`로 임의의 신규 EOA 주소를 가장(개인키 불필요, 로컬 포크 전용 cheat code) — 실제 사용자 지갑을 가져다 쓰지 않음(프라이버시·무관성)

## 대상 컨트랙트 (Polygon 메인넷 실주소, 포크에 그대로 존재)

| 이름 | 주소 |
|---|---|
| WMATIC (Wrapped Matic, ERC-20) | `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270` |
| USDC.e (bridged USDC, ERC-20) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| QuickSwap V2 Router | `0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff` (실험1과 동일 — 유동성 실존 확인됨) |

## 미션 구조 — "approve → transfer → 컨트랙트 호출" (논문 세션 지시 예시 반영)

실제 ERC-20은 `approve`만으로는 선행 자금이 필요 없지만 `transfer`는 잔고가 있어야 하므로, 자금 확보를 위한 **사전 준비 단계(설정, 세션에 포함하지 않음)** 를 1개 두고, 채점 대상 "미션 액션"은 지시대로 정확히 3종(approve/transfer/컨트랙트 호출)으로 구성한다.

| 순서 | 종류 | 함수 | 세션 포함 여부 |
|---|---|---|---|
| 0 (준비) | 자금 확보 | `WMATIC.deposit()` (payable, POL→WMATIC 랩핑, 10 WMATIC) | ❌ 제외 (설정용, raw TX 목록에서 필터링) |
| 1 | **approve** | `WMATIC.approve(ROUTER, 5 WMATIC)` | ✅ actionType=`approve` |
| 2 | **transfer** | `WMATIC.transfer(secondWallet, 0.1 WMATIC)` | ✅ actionType=`transfer` |
| 3 | **컨트랙트 호출** | `Router.swapExactTokensForTokens(1 WMATIC → USDC.e, amountOutMin=0, deadline=고정 미래값)` | ✅ actionType=`swapExactTokensForTokens` |

raw TX 데이터는 adapter(`OnchainTxAdapter.normalize`)가 기대하는 Etherscan 호환 셰이프로 직접 구성한다 — 각 필드(해시·블록번호·타임스탬프·from/to·gas·gasUsed·input·status)는 anvil의 실제 `eth_getTransactionByHash`/`eth_getTransactionReceipt`/`eth_getBlockByNumber` 응답에서 그대로 가져온 값이며, `functionName`만 우리가 호출한 실제 함수 시그니처를 직접 기입한다(로컬 포크엔 Etherscan 같은 explorer가 없어 verified-source functionName을 자동으로 못 받아오므로, 우리가 보낸 calldata와 100% 일치하는 ground-truth 값을 수기 기입 — 추정이나 가짜 데이터 아님).

## 타임스탬프 제어

anvil의 `evm_setNextBlockTimestamp` cheat code로 각 TX가 채굴될 블록의 타임스탬프를 정확히 지정한다. 실제 벽시계 대기(수십~수백 초) 없이 "지갑이 의도한 시간 간격으로 행동했다"는 상황을 결정적으로 재현하기 위함이며, 각 TX 자체는 실제 EVM 실행(가스 소비·revert 포함)을 거친다 — 타임스탬프만 통제할 뿐 실행 결과는 조작하지 않는다.

## 지갑 3종 시나리오 (시나리오당 5개 독립 지갑, 각 1세션)

파이프라인 코드 분석(`FeatureExtractor` 5개 extractor) 결과, 아래 메커니즘이 이미 구현되어 있음을 확인했다 — 실험 목적은 이 방어 메커니즘이 **실제로 작동하는지 실측 검증**하는 것이다.

### (a) 정상 수행 — 베이스라인
- approve(t=0) → transfer(t=+90s) → swap(t=+200s) — 간격 90s/110s, 평균 100s(≥60s → `applyHumanPacePenalty` 미적용 구간, 순수 베이스라인)
- 5개 지갑, 각 1회만 수행

### (b) 같은 입력 반복 TX 추가 — "부풀리기" 시도 1
- (a)와 동일한 정상 1회전 수행 후, **동일 금액·동일 수신자·동일 deadline**(바이트 단위로 완전히 같은 calldata)로 approve→transfer→swap 전체를 1회 더 반복(t=+320/+410/+520s, 간격 역시 ≥60s로 "봇 페이스 패널티"와 분리해 순수 "중복 입력" 효과만 관찰)
- 가설: `EfficiencyExtractor`의 `duplicateInputPenalty`(동일 `inputDigest` 중복 시 페널티)가 작동해 "성공 액션 2배"가 "효율성 2배"로 이어지지 않아야 함
- 5개 지갑

### (c) 5초 이내 실패 재시도 반복 — "부풀리기" 시도 2
- (a)와 동일한 정상 1회전 수행 후, **잔고 초과 transfer**(명백히 revert)를 동일 calldata로 t=+320/+323/+326/+329s(3초 간격, `RAPID_THRESHOLD_SECONDS=5` 미만)에 4회 연속 시도
- 가설: `RiskPatternExtractor`의 `consecutiveFailRate`·`rapidRetryRate`가 반응해 riskPattern 값이 하락해야 함
- 5개 지갑

### 측정 항목
각 지갑(세션)마다 5개 특징값(efficiency/stability/coherence/riskPattern/excellence) + 최종 `score`·`grade`를 기록하고, 시나리오별 5개 지갑의 평균·표준편차를 비교한다.

## 투명성 고지

- ruleSetId는 실험1·3과 동일한 `GENERIC-R1`(이 ruleSet은 placeholder issuer로 실제 SBT 발급에 쓰이지 않음, 이미 REPORT.md에 명시됨) — 본 실험도 동일하게 **실제 자격 발급과 무관한 순수 측정 목적**임을 재확인.
- 본 섹션 전체에 "로컬 포크 환경"임을 명시한다(논문 세션 지시 준수) — 모든 수치는 Polygon 메인넷 로컬 포크에서 실측한 것이며, 실제 메인넷에는 어떤 TX도 전송되지 않았다.
