// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAtsToken, ICompliance, AtsRoles} from "./ats/IAtsToken.sol";
import {Wire} from "./Wire.sol";

/// @title CustodyOracle
/// @notice Makes an Asset Tokenization Studio (ATS) warehouse-receipt token react to what a
///         sensor device signed and what a 0G model decided at each custody handoff.
///
///         It plugs into ATS in two places:
///         - as the token's ERC-3643 compliance module, so units only move while a venue holds
///           the goods (not in transit, not after a breach);
///         - as holder of the freeze role, so a confirmed breach freezes every holder's units
///           until an inspector releases the lot.
///
///         Nobody is trusted to call it. `submitCheckpoint` is open to anyone and acts only on
///         two signatures: the device's over the checkpoint, and the attestor's over the 0G
///         decision. A freeze additionally needs a device-signed out-of-range reading, checked
///         here against the lot's limits: the model can refuse a handoff, but only the sensor's
///         own signature can prove a breach.
/// @dev The state machine is specified in packages/protocol/src/policy.ts and both
///      implementations are checked against the same 384-row table.
contract CustodyOracle is ICompliance {
    // -----------------------------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------------------------

    enum LotState {
        NONE,
        REGISTERED, // known, no custody accepted yet: nothing can be issued or moved
        IN_CUSTODY, // a venue holds the goods: units can be issued, traded and redeemed
        IN_TRANSIT, // on the road: transfers are restricted
        FROZEN, // breach confirmed: holders' units are frozen until released
        DELIVERED // at the consignee: units can only be redeemed
    }

    enum Outcome {
        NONE,
        ACCEPTED, // custody accepted, lot moved to its next state
        REFUSED, // handoff refused, token untouched
        FROZEN, // breach confirmed, units frozen
        ESCALATED, // the model asked for a human, nothing changed
        BLOCKED_BY_BREACH, // the model said accept but a breach is on record, nothing changed
        RELEASED // an inspector cleared the lot
    }

    struct LotConfig {
        bytes32 lotId; // the lot id as ASCII, zero-padded (the asset_id of the wire formats)
        address token; // the ATS security token for this lot
        address device; // device wallet whose signatures count for this lot
        address attestor; // gateway key that relays 0G decisions
        address inspector; // who may release the lot after a freeze
        int32 tempMinCenti;
        int32 tempMaxCenti;
        uint32 rhMinCenti;
        uint32 rhMaxCenti;
    }

    struct Lot {
        address token;
        address device;
        address attestor;
        address inspector;
        address registrar;
        int32 tempMinCenti;
        int32 tempMaxCenti;
        uint32 rhMinCenti;
        uint32 rhMaxCenti;
        LotState state;
        bool breachOpen; // a breach is on record and not yet cleared by the inspector
        uint64 lastSeq; // seq of the last checkpoint applied (replay protection)
        uint64 clearedSeq; // readings up to this seq were cleared by an inspector
        uint64 registeredAt;
        uint64 updatedAt;
    }

    struct Record {
        bytes32 checkpointDigest; // checkpoint id, or the inspection reference for a release
        bytes32 requestIdHash; // SHA-256 of the 0G request id
        bytes32 episodeRoot; // 0G Storage root of the episode log
        uint64 seq;
        uint64 ts; // device time of the checkpoint
        uint64 appliedAt; // block time it was applied
        uint8 kind;
        uint8 decision;
        Outcome outcome;
        LotState stateAfter;
        bool breachProven;
    }

    // Wire values of checkpoint kinds and decisions (see packages/protocol).
    uint8 internal constant KIND_WAREHOUSE_IN = 1;
    uint8 internal constant KIND_WAREHOUSE_OUT = 2;
    uint8 internal constant KIND_DOCK_HANDOFF = 3;
    uint8 internal constant KIND_FINAL_DELIVERY = 4;
    uint8 internal constant DECISION_PENDING = 0;
    uint8 internal constant DECISION_ACCEPT_CUSTODY = 1;
    uint8 internal constant DECISION_REJECT = 2;
    uint8 internal constant DECISION_ESCALATE = 3;

    /// @notice Holders handled per call when freezing or unfreezing, to bound gas.
    uint256 public constant HOLDER_PAGE = 50;

    // -----------------------------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------------------------

    mapping(bytes32 lotId => Lot) private _lots;
    mapping(bytes32 lotId => Record[]) private _history;
    bytes32[] private _lotIds;

    /// @notice The lot a token belongs to (zero if the token is not registered here).
    mapping(address token => bytes32 lotId) public lotOfToken;

    /// @notice Units this oracle froze for a holder, so a release unfreezes exactly those.
    mapping(bytes32 lotId => mapping(address holder => uint256)) public frozenUnits;
    mapping(bytes32 lotId => address[]) private _frozenHolders;
    /// @notice Next page of token holders still to freeze; non-zero only mid-freeze.
    mapping(bytes32 lotId => uint256) public freezePage;
    /// @notice True while some holders of a frozen lot have not been frozen yet.
    mapping(bytes32 lotId => bool) public freezePending;

    // -----------------------------------------------------------------------------------------
    // Events and errors
    // -----------------------------------------------------------------------------------------

    event LotRegistered(
        bytes32 indexed lotId,
        address indexed token,
        address indexed device,
        address attestor,
        address inspector,
        address registrar
    );
    event LotPartiesUpdated(bytes32 indexed lotId, address device, address attestor, address inspector);
    event CheckpointApplied(
        bytes32 indexed lotId,
        bytes32 indexed checkpointDigest,
        uint8 kind,
        uint8 decision,
        Outcome outcome,
        LotState stateAfter,
        uint64 seq,
        bytes32 requestIdHash,
        bytes32 episodeRoot
    );
    event BreachRecorded(
        bytes32 indexed lotId, bytes32 indexed readingDigest, int32 tempCenti, uint32 rhCenti, uint64 seq
    );
    event UnitsFrozen(bytes32 indexed lotId, address indexed holder, uint256 amount);
    event UnitsUnfrozen(bytes32 indexed lotId, address indexed holder, uint256 amount);
    event FreezeDeferred(bytes32 indexed lotId, address holder);
    event UnfreezeDeferred(bytes32 indexed lotId, address holder);
    event LotReleased(
        bytes32 indexed lotId, address indexed inspector, bytes32 inspectionRef, uint64 clearedThroughSeq
    );

    error InvalidConfig(string reason);
    error LotExists(bytes32 lotId);
    error UnknownLot(bytes32 lotId);
    error TokenAlreadyBound(address token);
    error NotTokenAdmin(address caller);
    error NotWiredAsCompliance(address token);
    error NotRegistrar(address caller);
    error NotInspector(address caller);
    error NotSignedByDevice();
    error NotSignedByAttestor();
    error StaleCheckpoint(uint64 seq, uint64 lastSeq);
    error AttestationMismatch();
    error BreachEvidenceMissing();
    error EvidenceNotForLot();
    error EvidenceOutsideWindow(uint64 seq, uint64 firstSeq, uint64 lastSeq);
    error EvidenceAlreadyCleared(uint64 seq, uint64 clearedSeq);
    error NotABreach(int32 tempCenti, uint32 rhCenti);
    error InvalidTransition(LotState state, uint8 kind, uint8 decision);
    error NothingToRelease(bytes32 lotId);
    error NotFrozen(bytes32 lotId);

    // -----------------------------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------------------------

    /// @notice Binds a lot to its ATS token, device, attestor and inspector.
    /// @dev Open to anyone who administers the token, and only for a token that already names
    ///      this contract as its compliance module, so a lot cannot be registered for somebody
    ///      else's token. The token also has to grant this contract ROLE_FREEZE_MANAGER for the
    ///      freeze to take effect; without it a breach still blocks every transfer.
    function registerLot(LotConfig calldata config) external {
        if (config.lotId == bytes32(0)) revert InvalidConfig("lotId");
        if (config.token == address(0)) revert InvalidConfig("token");
        if (config.device == address(0)) revert InvalidConfig("device");
        if (config.attestor == address(0)) revert InvalidConfig("attestor");
        if (config.inspector == address(0)) revert InvalidConfig("inspector");
        if (config.tempMinCenti > config.tempMaxCenti) revert InvalidConfig("temperature band");
        if (config.rhMinCenti > config.rhMaxCenti || config.rhMaxCenti > 10_000) {
            revert InvalidConfig("humidity band");
        }
        if (_lots[config.lotId].state != LotState.NONE) revert LotExists(config.lotId);
        if (lotOfToken[config.token] != bytes32(0)) revert TokenAlreadyBound(config.token);

        IAtsToken token = IAtsToken(config.token);
        if (!token.hasRole(AtsRoles.DEFAULT_ADMIN, msg.sender)) revert NotTokenAdmin(msg.sender);
        if (token.compliance() != address(this)) revert NotWiredAsCompliance(config.token);

        _lots[config.lotId] = Lot({
            token: config.token,
            device: config.device,
            attestor: config.attestor,
            inspector: config.inspector,
            registrar: msg.sender,
            tempMinCenti: config.tempMinCenti,
            tempMaxCenti: config.tempMaxCenti,
            rhMinCenti: config.rhMinCenti,
            rhMaxCenti: config.rhMaxCenti,
            state: LotState.REGISTERED,
            breachOpen: false,
            lastSeq: 0,
            clearedSeq: 0,
            registeredAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp)
        });
        lotOfToken[config.token] = config.lotId;
        _lotIds.push(config.lotId);

        emit LotRegistered(
            config.lotId, config.token, config.device, config.attestor, config.inspector, msg.sender
        );
    }

    /// @notice Replaces the device, attestor or inspector of a lot (a broken device, a rotated
    ///         key). Only the account that registered the lot may do this, and it is logged.
    function setLotParties(bytes32 lotId, address device, address attestor, address inspector) external {
        Lot storage lot = _requireLot(lotId);
        if (msg.sender != lot.registrar) revert NotRegistrar(msg.sender);
        if (device == address(0)) revert InvalidConfig("device");
        if (attestor == address(0)) revert InvalidConfig("attestor");
        if (inspector == address(0)) revert InvalidConfig("inspector");
        lot.device = device;
        lot.attestor = attestor;
        lot.inspector = inspector;
        lot.updatedAt = uint64(block.timestamp);
        emit LotPartiesUpdated(lotId, device, attestor, inspector);
    }

    // -----------------------------------------------------------------------------------------
    // Checkpoints
    // -----------------------------------------------------------------------------------------

    /// @notice Applies a decided custody checkpoint to its lot. Callable by anyone.
    /// @param checkpoint       PPC1 payload (221 bytes) the device signed.
    /// @param deviceSig        The device's signature over SHA-256(checkpoint).
    /// @param attestation      PPX1 payload (110 bytes) relaying the 0G decision.
    /// @param attestorSig      The attestor's signature over SHA-256(attestation).
    /// @param breachReading    Optional PPR1 payload (144 bytes): an out-of-range reading from
    ///                         this checkpoint's window. Empty when no breach is being proven.
    /// @param breachReadingSig The device's signature over SHA-256(breachReading).
    function submitCheckpoint(
        bytes calldata checkpoint,
        bytes calldata deviceSig,
        bytes calldata attestation,
        bytes calldata attestorSig,
        bytes calldata breachReading,
        bytes calldata breachReadingSig
    ) external returns (Outcome outcome) {
        (Wire.Checkpoint memory cp, bytes32 digest) = _authenticateCheckpoint(checkpoint, deviceSig);
        Wire.Attestation memory att = _authenticateDecision(cp.assetId, digest, attestation, attestorSig);
        bool breachProven = _checkEvidence(cp, att.breach, breachReading, breachReadingSig);
        outcome = _apply(cp, digest, att, breachProven);
    }

    /// @dev Step 1: the checkpoint is for a known lot, signed by its device, and new.
    function _authenticateCheckpoint(bytes calldata checkpoint, bytes calldata deviceSig)
        private
        view
        returns (Wire.Checkpoint memory cp, bytes32 digest)
    {
        cp = Wire.decodeCheckpoint(checkpoint);
        Lot storage lot = _requireLot(cp.assetId);
        digest = sha256(checkpoint);
        if (cp.device != lot.device || Wire.recover(digest, deviceSig) != lot.device) {
            revert NotSignedByDevice();
        }
        if (cp.seq <= lot.lastSeq) revert StaleCheckpoint(cp.seq, lot.lastSeq);
    }

    /// @dev Step 2: the decision is about this very checkpoint and signed by the lot's attestor.
    function _authenticateDecision(
        bytes32 lotId,
        bytes32 checkpointDigest,
        bytes calldata attestation,
        bytes calldata attestorSig
    ) private view returns (Wire.Attestation memory att) {
        att = Wire.decodeAttestation(attestation);
        if (att.checkpointDigest != checkpointDigest) revert AttestationMismatch();
        if (Wire.recover(sha256(attestation), attestorSig) != _lots[lotId].attestor) {
            revert NotSignedByAttestor();
        }
    }

    /// @dev Step 3: if a breach is claimed, the device-signed reading proving it is present,
    ///      out of range, and from this checkpoint's window.
    function _checkEvidence(
        Wire.Checkpoint memory cp,
        bool attestedBreach,
        bytes calldata breachReading,
        bytes calldata breachReadingSig
    ) private returns (bool breachProven) {
        Lot storage lot = _lots[cp.assetId];
        if (breachReading.length == 0) {
            // The attestor says a reading was out of range: the signed reading must come with it,
            // unless that breach is already on record.
            if (attestedBreach && !lot.breachOpen) revert BreachEvidenceMissing();
            return false;
        }
        Wire.Reading memory reading = _requireBreach(cp.assetId, lot, breachReading, breachReadingSig);
        if (reading.seq < cp.firstSeq || reading.seq > cp.lastSeq) {
            revert EvidenceOutsideWindow(reading.seq, cp.firstSeq, cp.lastSeq);
        }
        return true;
    }

    /// @dev Step 4: run the state machine, record the result, and freeze if it says so.
    function _apply(Wire.Checkpoint memory cp, bytes32 digest, Wire.Attestation memory att, bool breachProven)
        private
        returns (Outcome outcome)
    {
        bytes32 lotId = cp.assetId;
        Lot storage lot = _lots[lotId];
        LotState previous = lot.state;
        bool ok;
        LotState next;
        bool breachOpenAfter;
        (ok, outcome, next, breachOpenAfter) =
            previewCheckpoint(previous, lot.breachOpen, cp.kind, att.decision, breachProven);
        if (!ok) revert InvalidTransition(previous, cp.kind, att.decision);

        lot.state = next;
        lot.breachOpen = breachOpenAfter;
        lot.lastSeq = cp.seq;
        lot.updatedAt = uint64(block.timestamp);
        _record(
            lotId,
            Record({
                checkpointDigest: digest,
                requestIdHash: att.requestIdHash,
                episodeRoot: att.episodeRoot,
                seq: cp.seq,
                ts: cp.ts,
                appliedAt: uint64(block.timestamp),
                kind: cp.kind,
                decision: att.decision,
                outcome: outcome,
                stateAfter: next,
                breachProven: breachProven
            })
        );

        if (next == LotState.FROZEN && previous != LotState.FROZEN) {
            freezePage[lotId] = 0;
            _freezeNextPage(lotId, lot);
        }
    }

    function _record(bytes32 lotId, Record memory entry) private {
        _history[lotId].push(entry);
        emit CheckpointApplied(
            lotId,
            entry.checkpointDigest,
            entry.kind,
            entry.decision,
            entry.outcome,
            entry.stateAfter,
            entry.seq,
            entry.requestIdHash,
            entry.episodeRoot
        );
    }

    /// @notice Puts a breach on record outside a checkpoint. Callable by anyone holding an
    ///         out-of-range reading the lot's device signed. It does not freeze by itself — a
    ///         freeze still needs a REJECT — but custody cannot be accepted until an inspector
    ///         has looked.
    function reportBreach(bytes calldata reading, bytes calldata readingSig) external {
        Wire.Reading memory decoded = Wire.decodeReading(reading);
        Lot storage lot = _requireLot(decoded.assetId);
        if (lot.state == LotState.DELIVERED) revert InvalidTransition(lot.state, 0, 0);
        _requireBreach(decoded.assetId, lot, reading, readingSig);
        lot.breachOpen = true;
        lot.updatedAt = uint64(block.timestamp);
    }

    /// @notice The custody state machine as a pure function: what a decision would do.
    /// @dev Mirrors `applyCheckpoint` in packages/protocol/src/policy.ts.
    function previewCheckpoint(LotState state, bool breachOpen, uint8 kind, uint8 decision, bool breachProven)
        public
        pure
        returns (bool ok, Outcome outcome, LotState next, bool breachOpenAfter)
    {
        if (state == LotState.NONE || state == LotState.DELIVERED || decision == DECISION_PENDING) {
            return (false, Outcome.NONE, state, breachOpen);
        }
        // Presenting signed breach evidence puts the breach on record whatever the decision is.
        breachOpenAfter = breachOpen || breachProven;

        if (decision == DECISION_ESCALATE) return (true, Outcome.ESCALATED, state, breachOpenAfter);

        if (decision == DECISION_REJECT) {
            if (breachOpenAfter) return (true, Outcome.FROZEN, LotState.FROZEN, breachOpenAfter);
            return (true, Outcome.REFUSED, state, breachOpenAfter);
        }

        // ACCEPT_CUSTODY from here on.
        if (state == LotState.FROZEN) return (false, Outcome.NONE, state, breachOpen);
        if (breachOpenAfter) return (true, Outcome.BLOCKED_BY_BREACH, state, breachOpenAfter);

        if (kind == KIND_WAREHOUSE_IN && (state == LotState.REGISTERED || state == LotState.IN_TRANSIT)) {
            return (true, Outcome.ACCEPTED, LotState.IN_CUSTODY, breachOpenAfter);
        }
        if (kind == KIND_DOCK_HANDOFF && state == LotState.IN_TRANSIT) {
            return (true, Outcome.ACCEPTED, LotState.IN_CUSTODY, breachOpenAfter);
        }
        if (kind == KIND_WAREHOUSE_OUT && state == LotState.IN_CUSTODY) {
            return (true, Outcome.ACCEPTED, LotState.IN_TRANSIT, breachOpenAfter);
        }
        if (kind == KIND_FINAL_DELIVERY && (state == LotState.IN_CUSTODY || state == LotState.IN_TRANSIT)) {
            return (true, Outcome.ACCEPTED, LotState.DELIVERED, breachOpenAfter);
        }
        return (false, Outcome.NONE, state, breachOpen);
    }

    // -----------------------------------------------------------------------------------------
    // Freeze, release
    // -----------------------------------------------------------------------------------------

    /// @notice Freezes the next page of holders of a frozen lot. Callable by anyone; only needed
    ///         when a lot has more than `HOLDER_PAGE` holders or a freeze call was deferred.
    function continueFreeze(bytes32 lotId) external {
        Lot storage lot = _requireLot(lotId);
        if (lot.state != LotState.FROZEN) revert NotFrozen(lotId);
        _freezeNextPage(lotId, lot);
    }

    /// @notice Clears a breach after inspection: unfreezes the units this oracle froze and puts
    ///         the lot back in custody (of the venue where it was inspected).
    /// @param inspectionRef     A reference to the inspection report (for example its hash).
    /// @param clearedThroughSeq The device seq up to which readings are covered by the
    ///                          inspection; older readings can no longer open a breach.
    function release(bytes32 lotId, bytes32 inspectionRef, uint64 clearedThroughSeq) external {
        Lot storage lot = _requireLot(lotId);
        if (msg.sender != lot.inspector) revert NotInspector(msg.sender);
        if (lot.state != LotState.FROZEN && !lot.breachOpen) revert NothingToRelease(lotId);

        if (lot.state == LotState.FROZEN) lot.state = LotState.IN_CUSTODY;
        lot.breachOpen = false;
        if (clearedThroughSeq < lot.lastSeq) clearedThroughSeq = lot.lastSeq;
        lot.clearedSeq = clearedThroughSeq;
        lot.updatedAt = uint64(block.timestamp);
        freezePage[lotId] = 0;
        freezePending[lotId] = false;

        _history[lotId].push(
            Record({
                checkpointDigest: inspectionRef,
                requestIdHash: bytes32(0),
                episodeRoot: bytes32(0),
                seq: clearedThroughSeq,
                ts: uint64(block.timestamp),
                appliedAt: uint64(block.timestamp),
                kind: 0,
                decision: 0,
                outcome: Outcome.RELEASED,
                stateAfter: lot.state,
                breachProven: false
            })
        );
        emit LotReleased(lotId, msg.sender, inspectionRef, clearedThroughSeq);
        _unfreezePage(lotId, lot);
    }

    /// @notice Unfreezes more holders of a released lot. Callable by anyone; only needed when a
    ///         lot had more than `HOLDER_PAGE` frozen holders or an unfreeze call was deferred.
    function continueUnfreeze(bytes32 lotId) external {
        Lot storage lot = _requireLot(lotId);
        if (lot.state == LotState.FROZEN) revert InvalidTransition(lot.state, 0, 0);
        _unfreezePage(lotId, lot);
    }

    // -----------------------------------------------------------------------------------------
    // ERC-3643 compliance module (called by the ATS token)
    // -----------------------------------------------------------------------------------------

    /// @notice Whether the calling token may move `from -> to` right now.
    /// @dev ATS asks this for transfers, for issuance (`from == 0`) and for redemption
    ///      (`to == 0`). A token that is not registered here gets `false` for everything.
    function canTransfer(address, address to, uint256) external view returns (bool) {
        LotState state = _lots[lotOfToken[msg.sender]].state;
        // Redemption: the holder takes delivery, from a warehouse or at the destination.
        if (to == address(0)) return state == LotState.IN_CUSTODY || state == LotState.DELIVERED;
        // Issuance (from == 0) and transfers: only while a venue has accepted custody.
        return state == LotState.IN_CUSTODY;
    }

    /// @dev ATS notifies the compliance module after each balance change. Nothing to track.
    function transferred(address, address, uint256) external {}

    function created(address, uint256) external {}

    function destroyed(address, uint256) external {}

    // -----------------------------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------------------------

    function getLot(bytes32 lotId) external view returns (Lot memory) {
        return _lots[lotId];
    }

    function lotCount() external view returns (uint256) {
        return _lotIds.length;
    }

    function lotIdAt(uint256 index) external view returns (bytes32) {
        return _lotIds[index];
    }

    function historyLength(bytes32 lotId) external view returns (uint256) {
        return _history[lotId].length;
    }

    /// @notice A page of a lot's history, oldest first.
    function getHistory(bytes32 lotId, uint256 offset, uint256 limit)
        external
        view
        returns (Record[] memory page)
    {
        Record[] storage all = _history[lotId];
        if (offset >= all.length) return new Record[](0);
        uint256 end = offset + limit;
        if (end > all.length) end = all.length;
        page = new Record[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = all[i];
        }
    }

    /// @notice Holders whose units this oracle currently holds frozen.
    function frozenHolderCount(bytes32 lotId) external view returns (uint256) {
        return _frozenHolders[lotId].length;
    }

    function frozenHolderAt(bytes32 lotId, uint256 index) external view returns (address) {
        return _frozenHolders[lotId][index];
    }

    /// @notice Whether a reading is inside the lot's limits (bounds inclusive).
    function isInRange(bytes32 lotId, int32 tempCenti, uint32 rhCenti) public view returns (bool) {
        Lot storage lot = _lots[lotId];
        return tempCenti >= lot.tempMinCenti && tempCenti <= lot.tempMaxCenti && rhCenti >= lot.rhMinCenti
            && rhCenti <= lot.rhMaxCenti;
    }

    // -----------------------------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------------------------

    function _requireLot(bytes32 lotId) private view returns (Lot storage lot) {
        lot = _lots[lotId];
        if (lot.state == LotState.NONE) revert UnknownLot(lotId);
    }

    /// @dev Reverts unless `reading` is an out-of-range reading for this lot, signed by its
    ///      device and newer than the last inspection.
    function _requireBreach(bytes32 lotId, Lot storage lot, bytes calldata reading, bytes calldata readingSig)
        private
        returns (Wire.Reading memory decoded)
    {
        decoded = Wire.decodeReading(reading);
        if (decoded.assetId != lotId || decoded.device != lot.device) revert EvidenceNotForLot();
        bytes32 digest = sha256(reading);
        if (Wire.recover(digest, readingSig) != lot.device) revert NotSignedByDevice();
        if (decoded.seq <= lot.clearedSeq) revert EvidenceAlreadyCleared(decoded.seq, lot.clearedSeq);
        if (isInRange(lotId, decoded.tempCenti, decoded.rhCenti)) {
            revert NotABreach(decoded.tempCenti, decoded.rhCenti);
        }
        emit BreachRecorded(lotId, digest, decoded.tempCenti, decoded.rhCenti, decoded.seq);
    }

    /// @dev Freezes the free balance of one page of holders. Token-side failures (the issuer
    ///      paused the token, or never granted the freeze role) are deferred rather than
    ///      reverted: the lot is FROZEN either way and `canTransfer` already blocks every move.
    function _freezeNextPage(bytes32 lotId, Lot storage lot) private {
        IAtsToken token = IAtsToken(lot.token);
        uint256 page = freezePage[lotId];
        address[] memory holders;
        try token.getSecurityHolders(page, HOLDER_PAGE) returns (address[] memory result) {
            holders = result;
        } catch {
            freezePending[lotId] = true;
            emit FreezeDeferred(lotId, address(0));
            return;
        }

        for (uint256 i = 0; i < holders.length; i++) {
            address holder = holders[i];
            uint256 free = token.balanceOf(holder);
            if (free == 0) continue;
            try token.freezePartialTokens(holder, free) {
                if (frozenUnits[lotId][holder] == 0) _frozenHolders[lotId].push(holder);
                frozenUnits[lotId][holder] += free;
                emit UnitsFrozen(lotId, holder, free);
            } catch {
                freezePending[lotId] = true;
                emit FreezeDeferred(lotId, holder);
                return;
            }
        }

        bool more = holders.length == HOLDER_PAGE;
        freezePending[lotId] = more;
        if (more) freezePage[lotId] = page + 1;
    }

    /// @dev Unfreezes up to one page of the holders this oracle froze, newest first.
    function _unfreezePage(bytes32 lotId, Lot storage lot) private {
        IAtsToken token = IAtsToken(lot.token);
        address[] storage holders = _frozenHolders[lotId];
        for (uint256 n = 0; n < HOLDER_PAGE && holders.length > 0; n++) {
            address holder = holders[holders.length - 1];
            uint256 amount = frozenUnits[lotId][holder];
            if (amount != 0) {
                try token.unfreezePartialTokens(holder, amount) {
                    emit UnitsUnfrozen(lotId, holder, amount);
                } catch {
                    emit UnfreezeDeferred(lotId, holder);
                    return;
                }
                frozenUnits[lotId][holder] = 0;
            }
            holders.pop();
        }
    }
}
