/**
 * 알려진 method selector → semantic actionType 매핑.
 *
 * Etherscan/Polygonscan V2 `functionName` 이 없거나(컨트랙트 unverified) methodId 만
 * 반환될 때 참조. `OnchainTxAdapter.normalize` 가 사용한다.
 *
 * 이 매핑이 있으므로 **응시자 verify 여부와 무관하게 actionType 을 결정**할 수 있다.
 * 즉 시험 채점이 컨트랙트 verify 상태에 종속되지 않는다 (Q3 확정 정책).
 *
 * 추가 셀렉터가 필요하면 여기에 추가. keccak256(signature).slice(0, 10) 로 계산.
 */

export type MethodSelector = `0x${string}`;

/**
 * 표준 라이브러리·프로토콜 method selectors.
 * SC-DEV-PRO-M1 시험 요구사항 커버 + 실전 관행 확장.
 */
export const KNOWN_SELECTORS: Readonly<Record<MethodSelector, string>> = {
  // -------- OpenZeppelin Ownable --------
  "0xf2fde38b": "transferOwnership", // transferOwnership(address)
  "0x715018a6": "renounceOwnership", // renounceOwnership()

  // -------- OpenZeppelin AccessControl --------
  "0x2f2ff15d": "grantRole",  // grantRole(bytes32,address)
  "0xd547741f": "revokeRole", // revokeRole(bytes32,address)
  "0x36568abe": "renounceRole", // renounceRole(bytes32,address)

  // -------- UUPS (OpenZeppelin UUPSUpgradeable) --------
  "0x3659cfe6": "upgradeTo",         // upgradeTo(address)
  "0x4f1ef286": "upgradeToAndCall",  // upgradeToAndCall(address,bytes)

  // -------- TimelockController (OpenZeppelin) --------
  "0x01d5062a": "schedule",       // schedule(address,uint256,bytes,bytes32,bytes32,uint256)
  "0x8f2a0bb0": "scheduleBatch",  // scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)
  "0x134008d3": "execute",        // execute(address,uint256,bytes,bytes32,bytes32)
  "0xe38335e5": "executeBatch",   // executeBatch(address[],uint256[],bytes[],bytes32,bytes32)
  "0xc4d252f5": "cancel",         // cancel(bytes32)
  "0x64d62353": "updateDelay",    // updateDelay(uint256)

  // -------- Gnosis Safe --------
  "0xb63e800d": "setup",           // setup(address[],uint256,address,bytes,address,address,uint256,address)
  "0x6a761202": "execTransaction", // execTransaction(...)
  "0x0d582f13": "addOwnerWithThreshold", // addOwnerWithThreshold(address,uint256)
  "0xf8dc5dd9": "removeOwner",     // removeOwner(address,address,uint256)
  "0x694e80c3": "changeThreshold", // changeThreshold(uint256)

  // -------- ERC-20 표준 --------
  "0xa9059cbb": "transfer",     // transfer(address,uint256)
  "0x095ea7b3": "approve",      // approve(address,uint256)
  "0x23b872dd": "transferFrom", // transferFrom(address,address,uint256)

  // -------- 공통 초기화 --------
  "0x8129fc1c": "initialize",     // initialize()
  // 다른 initialize 시그니처는 unverified 시 원본 selector 유지. 필요 시 계약별 추가

  // -------- ERC-721 --------
  "0x42842e0e": "safeTransferFrom", // safeTransferFrom(address,address,uint256)

  // -------- Multicall --------
  "0xac9650d8": "multicall", // multicall(bytes[])
} as const;

/**
 * 소문자화된 methodId 로 매핑 조회. 매칭 없으면 undefined.
 */
export function lookupSelector(methodId: string): string | undefined {
  const key = methodId.toLowerCase() as MethodSelector;
  return KNOWN_SELECTORS[key];
}
