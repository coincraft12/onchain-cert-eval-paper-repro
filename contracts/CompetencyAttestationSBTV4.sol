// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ERC721Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { EIP712Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import { ICompetencyAttestation } from "./interfaces/ICompetencyAttestation.sol";
import { IBaseTokenRenderer } from "./interfaces/IBaseTokenRenderer.sol";
import { ReportTypes } from "./lib/ReportTypes.sol";
import { ValidatorRegistry } from "./ValidatorRegistry.sol";

/// @title CompetencyAttestationSBT (v4)
/// @notice UUPS upgradeable + Soulbound. v4 Phase 1 — UUPS scaffold만 도입.
///         Phase 2에서 owner-only burn + 재발급 추가 예정.
///         Phase 1 시점 기능적 동작은 v3와 동일하되 ERC1967Proxy 뒤에서 실행됨.
/// @dev 모든 storage 변수는 `__gap` 직전에만 추가한다. type/순서 변경 금지.
///      `_disableInitializers()`로 implementation 직접 사용 차단.
contract CompetencyAttestationSBTV4 is
    Initializable,
    ERC721Upgradeable,
    EIP712Upgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    ICompetencyAttestation
{
    event Locked(uint256 tokenId);
    event RendererUpdated(address indexed previous, address indexed current);
    event MissionSerialPrefixUpdated(bytes32 indexed missionId, string prefix);
    event IssuanceYearUpdated(uint16 oldYear, uint16 newYear);

    /// @notice v4 — owner-only burn 시 발행되는 이벤트. off-chain audit 추적 핵심.
    /// @dev 재발급은 별도 트랜잭션(issueOrUpdate)으로 처리 — burn 함수 내부에서 mint 없음.
    event Revoked(
        uint256 indexed tokenId,
        address indexed previousOwner,
        RevocationReason reason,
        uint256 timestamp
    );

    /// @notice v4 — burn 사유 enum. 추가 시 끝에만 append (off-chain DB enum과 동기 필수).
    enum RevocationReason {
        USER_REQUEST_WALLET_LOSS, // 0 — 사용자 분실 신고
        FRAUD_DETECTED,           // 1 — 도용·위조 적발
        IDENTITY_THEFT,           // 2 — 신원 도용
        EXAM_REVOKED,             // 3 — 시험 자체 무효 처리
        LEGAL_REQUEST             // 4 — 법원 명령
    }

    bytes4 private constant _ERC5192_INTERFACE_ID = 0xb45a3c0e;

    struct SBTMetadata {
        address userAddress;
        bytes32 missionId;
        uint8   grade;
        uint16  score;
        bytes32 ruleSetId;
        bytes32 sessionRoot;
        bytes32 reportHash;
        uint64  issuedAt;
        uint64  updatedAt;
        uint64  expiresAt;
        bool    active;
        string  applicantName;
        uint32  serialNumber;
        uint16  serialYear;
    }

    // ───────────────────────────── Storage layout (DO NOT REORDER) ────────────
    // slot N+0
    ValidatorRegistry private _validatorRegistry;
    // slot N+1
    IBaseTokenRenderer public renderer;
    // slot N+2 (packed with renderer? no — interface address fills full slot)
    uint16 public currentIssuanceYear;
    // slot N+3 ~ N+8: mappings (each occupies one slot for the root)
    mapping(uint256 tokenId => SBTMetadata) private _metadata;
    mapping(address user => mapping(uint256 nonce => bool)) private _nonceUsed;
    mapping(bytes32 reportHash => bool) private _reportConsumed;
    mapping(bytes32 missionId => mapping(bytes32 ruleSetId => bool)) private _approvedRuleSets;
    mapping(bytes32 missionId => uint32) public missionSerialCounter;
    mapping(bytes32 missionId => string) public missionSerialPrefix;

    // ───────────────────────────── v4 Burn / Revocation storage ───────────────
    // slot N+9
    mapping(uint256 tokenId => bool) public revoked;
    // slot N+10
    mapping(uint256 tokenId => RevocationReason) public revocationReason;
    // slot N+11
    mapping(uint256 tokenId => uint64) public revokedAt;

    // ───────────────────────────── Storage gap (47 slots) ─────────────────────
    // Phase 2에서 revoked/revocationReason/revokedAt 3개 추가 — gap 50→47 차감
    // 추가 시 반드시 __gap[47] → __gap[N-k] 로 줄이고 위에 명시
    uint256[47] private __gap;

    // ───────────────────────────── Errors ─────────────────────────────────────
    error ExpiredPayload(uint256 expiry, uint256 nowTs);
    error ReplayDetectedNonce(address user, uint256 nonce);
    error ReplayDetectedReportHash(bytes32 reportHash);
    error RuleSetNotApproved(bytes32 missionId, bytes32 ruleSetId);
    error ChainIdMismatch(uint256 reportChainId, uint256 actualChainId);
    error ThresholdNotMet(uint256 valid, uint256 required);
    error InvalidSignatureLengthMismatch();
    error InvalidSignatureRecovery();
    error DuplicateSigner(address signer);
    error InactiveValidator(address signer);
    error SBTTransferDisabled();
    error RendererNotSet();
    error IssuanceYearNotSet();
    error MissionSerialPrefixNotSet(bytes32 missionId);
    error EmptyApplicantName();
    error AlreadyIssued(uint256 tokenId);
    error TokenAlreadyRevoked(uint256 tokenId);
    error TokenDoesNotExist(uint256 tokenId);

    // ───────────────────────────── Constructor / Initializer ──────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice ERC1967Proxy 배포 직후 1회만 호출. 두 번째 호출은 revert.
    /// @dev owner_는 TimelockController 주소를 권장 (실제 운영). 테스트에선 EOA 가능.
    function initialize(
        string memory name_,
        string memory symbol_,
        address validatorRegistry_,
        address owner_
    ) external initializer {
        __ERC721_init(name_, symbol_);
        __EIP712_init("CoinCraftCompetencyAttestation", "1");
        __Ownable_init(owner_);
        // UUPSUpgradeable v5는 stateless — init 불필요 (OZ가 단순 re-export)

        _validatorRegistry = ValidatorRegistry(validatorRegistry_);
    }

    /// @dev UUPS upgrade 권한 — owner 만. 운영에선 Multisig 2-of-3 → Timelock 24h → 이 함수.
    function _authorizeUpgrade(address /*newImplementation*/) internal override onlyOwner {}

    // ───────────────────────────── Admin ──────────────────────────────────────

    function validatorRegistry() external view returns (address) {
        return address(_validatorRegistry);
    }

    function approveRuleSet(bytes32 missionId, bytes32 ruleSetId) external onlyOwner {
        _approvedRuleSets[missionId][ruleSetId] = true;
        emit RuleSetApproved(missionId, ruleSetId);
    }

    function revokeRuleSet(bytes32 missionId, bytes32 ruleSetId) external onlyOwner {
        _approvedRuleSets[missionId][ruleSetId] = false;
        emit RuleSetRevoked(missionId, ruleSetId);
    }

    function setRenderer(IBaseTokenRenderer renderer_) external onlyOwner {
        address old = address(renderer);
        renderer = renderer_;
        emit RendererUpdated(old, address(renderer_));
    }

    function setMissionSerialPrefix(bytes32 missionId, string calldata prefix) external onlyOwner {
        missionSerialPrefix[missionId] = prefix;
        emit MissionSerialPrefixUpdated(missionId, prefix);
    }

    function setCurrentIssuanceYear(uint16 year) external onlyOwner {
        uint16 old = currentIssuanceYear;
        currentIssuanceYear = year;
        emit IssuanceYearUpdated(old, year);
    }

    // ───────────────────────────── Core ───────────────────────────────────────

    function issueOrUpdate(
        ReportTypes.ResultReport calldata report,
        ReportTypes.SignaturePackage calldata sigPackage
    ) external override {
        if (block.timestamp > report.expiry) revert ExpiredPayload(report.expiry, block.timestamp);
        if (report.chainId != block.chainid) revert ChainIdMismatch(report.chainId, block.chainid);
        if (bytes(report.applicantName).length == 0) revert EmptyApplicantName();
        if (!_approvedRuleSets[report.missionId][report.ruleSetId]) {
            revert RuleSetNotApproved(report.missionId, report.ruleSetId);
        }
        if (_nonceUsed[report.userAddress][report.nonce]) {
            revert ReplayDetectedNonce(report.userAddress, report.nonce);
        }
        if (_reportConsumed[report.reportHash]) {
            revert ReplayDetectedReportHash(report.reportHash);
        }

        bytes32 digest = _hashTypedDataV4(ReportTypes.hashCompetencyReport(report, address(this)));
        _verifySignaturePackage(digest, sigPackage);

        _nonceUsed[report.userAddress][report.nonce] = true;
        _reportConsumed[report.reportHash] = true;
        emit ReportConsumed(report.userAddress, report.reportHash, report.ruleSetId, report.nonce);

        uint256 tokenId = computeTokenId(report.userAddress, report.missionId);
        if (_ownerOf(tokenId) != address(0)) revert AlreadyIssued(tokenId);
        // v4 — burn된 (user, missionId)는 같은 지갑으로 재발급 불가.
        // 재발급은 반드시 새 지갑(다른 user → 다른 tokenId)으로만.
        if (revoked[tokenId]) revert TokenAlreadyRevoked(tokenId);
        _mintSBT(tokenId, report);
    }

    /// @notice owner-only burn. 운영에선 Multisig 2-of-3 → Timelock 24h 거침.
    /// @dev `_nonceUsed[user][nonce]`와 `_reportConsumed[reportHash]`는 절대 reset하지 않는다
    ///      — burn 후에도 옛 보고서 재사용은 영구 차단(anti-replay invariant).
    ///      `_metadata[tokenId]`는 명시 delete — isEligible/getLatestAttestation의 stale 반환 차단.
    /// @param tokenId 소각 대상 토큰
    /// @param reason  사유 (off-chain audit DB enum과 동기)
    function burn(uint256 tokenId, RevocationReason reason) external onlyOwner {
        // revoked 체크 우선 — burn된 토큰과 미존재 토큰을 명확히 구분
        if (revoked[tokenId]) revert TokenAlreadyRevoked(tokenId);
        address previousOwner = _ownerOf(tokenId);
        if (previousOwner == address(0)) revert TokenDoesNotExist(tokenId);

        revoked[tokenId] = true;
        revocationReason[tokenId] = reason;
        revokedAt[tokenId] = uint64(block.timestamp);

        delete _metadata[tokenId];  // stale read 차단
        _burn(tokenId);              // OZ — _owners / _balances 정리

        emit Revoked(tokenId, previousOwner, reason, block.timestamp);
    }

    // ───────────────────────────── Views ──────────────────────────────────────

    function computeTokenId(address user, bytes32 missionId) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(user, missionId)));
    }

    function locked(uint256 /*tokenId*/) external pure returns (bool) {
        return true;
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC721Upgradeable) returns (bool) {
        return interfaceId == _ERC5192_INTERFACE_ID || super.supportsInterface(interfaceId);
    }

    function isEligible(address user, bytes32 missionId, uint8 minGrade)
        external view override returns (bool)
    {
        uint256 tokenId = computeTokenId(user, missionId);
        SBTMetadata storage m = _metadata[tokenId];
        if (m.userAddress == address(0) || !m.active) return false;
        if (m.expiresAt != 0 && block.timestamp > m.expiresAt) return false;
        return m.grade >= minGrade;
    }

    function getLatestAttestation(address user, bytes32 missionId)
        external view override
        returns (
            uint256 tokenId, uint16 score, uint8 grade,
            bytes32 ruleSetId, bytes32 sessionRoot, bytes32 reportHash,
            uint64 updatedAt, bool active
        )
    {
        tokenId = computeTokenId(user, missionId);
        SBTMetadata storage m = _metadata[tokenId];
        return (tokenId, m.score, m.grade, m.ruleSetId, m.sessionRoot, m.reportHash, m.updatedAt, m.active);
    }

    function getMetadata(uint256 tokenId) external view returns (SBTMetadata memory) {
        return _metadata[tokenId];
    }

    function isReportConsumed(bytes32 reportHash) external view returns (bool) {
        return _reportConsumed[reportHash];
    }

    function isNonceUsed(address user, uint256 nonce) external view returns (bool) {
        return _nonceUsed[user][nonce];
    }

    function isRuleSetApproved(bytes32 missionId, bytes32 ruleSetId) external view returns (bool) {
        return _approvedRuleSets[missionId][ruleSetId];
    }

    function hashReport(ReportTypes.ResultReport calldata report) external view returns (bytes32) {
        return _hashTypedDataV4(ReportTypes.hashCompetencyReport(report, address(this)));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        if (address(renderer) == address(0)) revert RendererNotSet();
        SBTMetadata storage m = _metadata[tokenId];
        IBaseTokenRenderer.TokenView memory v = IBaseTokenRenderer.TokenView({
            tokenId: tokenId,
            userAddress: m.userAddress,
            missionId: m.missionId,
            applicantName: m.applicantName,
            grade: m.grade,
            score: m.score,
            ruleSetId: m.ruleSetId,
            sessionRoot: m.sessionRoot,
            reportHash: m.reportHash,
            issuedAt: m.issuedAt,
            serialNumber: m.serialNumber,
            serialYear: m.serialYear,
            serialPrefix: missionSerialPrefix[m.missionId]
        });
        return renderer.tokenURI(v);
    }

    // ───────────────────────────── Internals ──────────────────────────────────

    function _verifySignaturePackage(bytes32 digest, ReportTypes.SignaturePackage calldata pkg) private view {
        uint256 sigCount = pkg.signatures.length;
        if (sigCount != pkg.signers.length) revert InvalidSignatureLengthMismatch();

        uint256 seenBits;
        uint256 valid;
        for (uint256 i; i < sigCount; ++i) {
            address claimed = pkg.signers[i];
            address recovered = ECDSA.recover(digest, pkg.signatures[i]);
            if (recovered != claimed) revert InvalidSignatureRecovery();
            if (!_validatorRegistry.isActive(claimed)) revert InactiveValidator(claimed);

            uint256 bit = uint256(1) << (uint160(claimed) & 0xff);
            if (seenBits & bit != 0) {
                for (uint256 j; j < i; ++j) {
                    if (pkg.signers[j] == claimed) revert DuplicateSigner(claimed);
                }
            }
            seenBits |= bit;
            ++valid;
        }

        uint256 required = _validatorRegistry.threshold();
        if (valid < required) revert ThresholdNotMet(valid, required);
    }

    /// @dev CEI 패턴 준수 — _metadata 작성을 _safeMint(외부 callback 가능) 앞에 둔다.
    ///      이로써 onERC721Received 콜백 도중에도 _metadata가 이미 채워져 있어
    ///      view 함수(isEligible, getMetadata, tokenURI)가 일관된 상태 반환.
    function _mintSBT(uint256 tokenId, ReportTypes.ResultReport calldata r) private {
        if (currentIssuanceYear == 0) revert IssuanceYearNotSet();
        if (bytes(missionSerialPrefix[r.missionId]).length == 0) {
            revert MissionSerialPrefixNotSet(r.missionId);
        }

        uint32 newSerial = missionSerialCounter[r.missionId] + 1;
        missionSerialCounter[r.missionId] = newSerial;

        _metadata[tokenId] = SBTMetadata({
            userAddress: r.userAddress,
            missionId: r.missionId,
            grade: r.grade,
            score: r.score,
            ruleSetId: r.ruleSetId,
            sessionRoot: r.sessionRoot,
            reportHash: r.reportHash,
            issuedAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            expiresAt: 0,
            active: true,
            applicantName: r.applicantName,
            serialNumber: newSerial,
            serialYear: currentIssuanceYear
        });

        _safeMint(r.userAddress, tokenId);  // 외부 callback 가능 — 위 storage 작성 완료 후에만 호출
        emit Locked(tokenId);
        emit TokenMinted(r.userAddress, r.missionId, tokenId, r.grade, r.ruleSetId);
    }

    // ───────────────────────────── Soulbound (영구 락) ────────────────────────

    function _update(address to, uint256 tokenId, address auth)
        internal override returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            revert SBTTransferDisabled();
        }
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override(ERC721Upgradeable) {
        revert SBTTransferDisabled();
    }

    function setApprovalForAll(address, bool) public pure override(ERC721Upgradeable) {
        revert SBTTransferDisabled();
    }
}
