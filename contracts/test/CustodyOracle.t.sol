// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CustodyOracle} from "../src/CustodyOracle.sol";
import {Wire} from "../src/Wire.sol";
import {MockAtsToken} from "./utils/MockAtsToken.sol";
import {WireBuilder as W} from "./utils/WireBuilder.sol";

contract CustodyOracleTest is Test {
    // The published test keys of contracts/vectors/protocol-v1.json.
    uint256 internal constant DEVICE_KEY = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint256 internal constant ATTESTOR_KEY =
        0x5555555555555555555555555555555555555555555555555555555555555555;
    uint256 internal constant STRANGER_KEY =
        0x7777777777777777777777777777777777777777777777777777777777777777;

    bytes32 internal constant LOT = bytes32("LOT-42");

    CustodyOracle internal oracle;
    MockAtsToken internal token;
    address internal device = vm.addr(DEVICE_KEY);
    address internal attestor = vm.addr(ATTESTOR_KEY);
    address internal issuer = makeAddr("issuer");
    address internal inspector = makeAddr("inspector");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    uint64 internal seq = 10;

    function setUp() public {
        vm.warp(1_793_966_400);
        oracle = new CustodyOracle();
        token = new MockAtsToken(issuer, address(oracle));
        vm.prank(issuer);
        oracle.registerLot(_config(LOT, address(token)));
    }

    // --- helpers ---------------------------------------------------------------------------

    function _config(bytes32 lotId, address token_) internal view returns (CustodyOracle.LotConfig memory) {
        return CustodyOracle.LotConfig({
            lotId: lotId,
            token: token_,
            device: device,
            attestor: attestor,
            inspector: inspector,
            tempMinCenti: 200,
            tempMaxCenti: 800,
            rhMinCenti: 2000,
            rhMaxCenti: 7000
        });
    }

    /// @dev Everything `submitCheckpoint` takes, built and signed up front. Signing calls the
    ///      SHA-256 precompile, so it must happen before a `vm.expectRevert` is armed.
    struct Bundle {
        bytes cp;
        bytes deviceSig;
        bytes att;
        bytes attestorSig;
        bytes reading;
        bytes readingSig;
    }

    /// @dev The next checkpoint for the lot, decided as `decision` and correctly signed.
    function _bundle(uint8 kind, uint8 decision, bool attestBreach) internal returns (Bundle memory b) {
        seq += 10;
        b.cp = W.checkpoint(device, LOT, kind, seq);
        b.deviceSig = W.sign(DEVICE_KEY, b.cp);
        b.att = W.attestation(b.cp, decision, attestBreach);
        b.attestorSig = W.sign(ATTESTOR_KEY, b.att);
    }

    function _withEvidence(Bundle memory b, bytes memory reading, uint256 signerKey)
        internal
        pure
        returns (Bundle memory)
    {
        b.reading = reading;
        b.readingSig = W.sign(signerKey, reading);
        return b;
    }

    function _send(Bundle memory b) internal returns (CustodyOracle.Outcome) {
        return oracle.submitCheckpoint(b.cp, b.deviceSig, b.att, b.attestorSig, b.reading, b.readingSig);
    }

    function _submit(uint8 kind, uint8 decision) internal returns (CustodyOracle.Outcome) {
        return _send(_bundle(kind, decision, false));
    }

    /// @dev Presents a too-warm reading from the checkpoint's window as breach evidence.
    function _submitWithBreach(uint8 kind, uint8 decision) internal returns (CustodyOracle.Outcome) {
        Bundle memory b = _bundle(kind, decision, true);
        return _send(_withEvidence(b, W.reading(device, LOT, 1260, 4550, seq - 1), DEVICE_KEY));
    }

    function _state() internal view returns (CustodyOracle.LotState) {
        return oracle.getLot(LOT).state;
    }

    function _toCustody() internal {
        _submit(W.WAREHOUSE_IN, W.ACCEPT_CUSTODY);
    }

    function _toTransit() internal {
        _toCustody();
        _submit(W.WAREHOUSE_OUT, W.ACCEPT_CUSTODY);
    }

    // --- registration ----------------------------------------------------------------------

    function test_registersALot() public view {
        CustodyOracle.Lot memory lot = oracle.getLot(LOT);
        assertEq(lot.token, address(token));
        assertEq(lot.device, device);
        assertEq(lot.attestor, attestor);
        assertEq(lot.inspector, inspector);
        assertEq(lot.registrar, issuer);
        assertEq(uint8(lot.state), uint8(CustodyOracle.LotState.REGISTERED));
        assertEq(oracle.lotOfToken(address(token)), LOT);
        assertEq(oracle.lotCount(), 1);
        assertEq(oracle.lotIdAt(0), LOT);
    }

    function test_onlyTheTokenAdminCanRegister() public {
        MockAtsToken other = new MockAtsToken(issuer, address(oracle));
        vm.expectRevert(abi.encodeWithSelector(CustodyOracle.NotTokenAdmin.selector, address(this)));
        oracle.registerLot(_config(bytes32("LOT-43"), address(other)));
    }

    function test_tokenMustNameTheOracleAsCompliance() public {
        MockAtsToken other = new MockAtsToken(issuer, makeAddr("another compliance module"));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CustodyOracle.NotWiredAsCompliance.selector, address(other)));
        oracle.registerLot(_config(bytes32("LOT-43"), address(other)));
    }

    function test_lotAndTokenAreRegisteredOnce() public {
        MockAtsToken other = new MockAtsToken(issuer, address(oracle));
        vm.startPrank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CustodyOracle.LotExists.selector, LOT));
        oracle.registerLot(_config(LOT, address(other)));
        vm.expectRevert(abi.encodeWithSelector(CustodyOracle.TokenAlreadyBound.selector, address(token)));
        oracle.registerLot(_config(bytes32("LOT-43"), address(token)));
        vm.stopPrank();
    }

    function test_rejectsAnInvertedBand() public {
        MockAtsToken other = new MockAtsToken(issuer, address(oracle));
        CustodyOracle.LotConfig memory config = _config(bytes32("LOT-43"), address(other));
        config.tempMinCenti = 900;
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CustodyOracle.InvalidConfig.selector, "temperature band"));
        oracle.registerLot(config);
    }

    // --- state machine ---------------------------------------------------------------------

    function test_happyPathFromRegistrationToDelivery() public {
        assertEq(uint8(_submit(W.WAREHOUSE_IN, W.ACCEPT_CUSTODY)), uint8(CustodyOracle.Outcome.ACCEPTED));
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.IN_CUSTODY));
        _submit(W.WAREHOUSE_OUT, W.ACCEPT_CUSTODY);
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.IN_TRANSIT));
        _submit(W.DOCK_HANDOFF, W.ACCEPT_CUSTODY);
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.IN_CUSTODY));
        _submit(W.FINAL_DELIVERY, W.ACCEPT_CUSTODY);
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.DELIVERED));

        assertEq(oracle.historyLength(LOT), 4);
        CustodyOracle.Record[] memory history = oracle.getHistory(LOT, 1, 2);
        assertEq(history.length, 2);
        assertEq(history[0].kind, W.WAREHOUSE_OUT);
        assertEq(uint8(history[1].stateAfter), uint8(CustodyOracle.LotState.IN_CUSTODY));
        assertEq(history[1].requestIdHash, sha256("0852f405-6c56-40c2-a800-e6fd70785065"));
    }

    function test_emitsCheckpointApplied() public {
        Bundle memory b = _bundle(W.WAREHOUSE_IN, W.ACCEPT_CUSTODY, false);
        vm.expectEmit(true, true, false, true);
        emit CustodyOracle.CheckpointApplied(
            LOT,
            sha256(b.cp),
            W.WAREHOUSE_IN,
            W.ACCEPT_CUSTODY,
            CustodyOracle.Outcome.ACCEPTED,
            CustodyOracle.LotState.IN_CUSTODY,
            seq,
            sha256("0852f405-6c56-40c2-a800-e6fd70785065"),
            keccak256("episode root")
        );
        _send(b);
    }

    function test_impossibleTransitionReverts() public {
        Bundle memory b = _bundle(W.WAREHOUSE_OUT, W.ACCEPT_CUSTODY, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustodyOracle.InvalidTransition.selector,
                CustodyOracle.LotState.REGISTERED,
                W.WAREHOUSE_OUT,
                W.ACCEPT_CUSTODY
            )
        );
        _send(b);
    }

    function test_escalateChangesNothing() public {
        _toTransit();
        assertEq(uint8(_submit(W.DOCK_HANDOFF, W.ESCALATE)), uint8(CustodyOracle.Outcome.ESCALATED));
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.IN_TRANSIT));
    }

    function test_pendingDecisionIsNeverApplied() public {
        Bundle memory b = _bundle(W.WAREHOUSE_IN, W.PENDING, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustodyOracle.InvalidTransition.selector,
                CustodyOracle.LotState.REGISTERED,
                W.WAREHOUSE_IN,
                W.PENDING
            )
        );
        _send(b);
    }

    // --- compliance module -----------------------------------------------------------------

    function test_unitsMoveOnlyWhileInCustody() public {
        vm.prank(issuer);
        vm.expectRevert(bytes("compliance: issue"));
        token.issue(alice, 100); // REGISTERED: nothing can be issued yet

        _toCustody();
        vm.prank(issuer);
        token.issue(alice, 100);
        vm.prank(alice);
        token.transfer(bob, 10);

        _submit(W.WAREHOUSE_OUT, W.ACCEPT_CUSTODY); // IN_TRANSIT
        vm.prank(alice);
        vm.expectRevert(bytes("compliance: transfer"));
        token.transfer(bob, 1);
        vm.prank(alice);
        vm.expectRevert(bytes("compliance: redeem"));
        token.redeem(1);
        vm.prank(issuer);
        vm.expectRevert(bytes("compliance: issue"));
        token.issue(alice, 1);
    }

    function test_afterDeliveryUnitsCanOnlyBeRedeemed() public {
        _toCustody();
        vm.prank(issuer);
        token.issue(alice, 100);
        _submit(W.FINAL_DELIVERY, W.ACCEPT_CUSTODY);

        vm.prank(alice);
        vm.expectRevert(bytes("compliance: transfer"));
        token.transfer(bob, 1);
        vm.prank(alice);
        token.redeem(100);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_unregisteredTokenCannotMoveAnything() public {
        vm.prank(makeAddr("some other token"));
        assertFalse(oracle.canTransfer(alice, bob, 1));
    }

    // --- signatures ------------------------------------------------------------------------

    function test_rejectsACheckpointSignedByAnotherKey() public {
        Bundle memory b = _bundle(W.WAREHOUSE_IN, W.ACCEPT_CUSTODY, false);
        b.deviceSig = W.sign(STRANGER_KEY, b.cp);
        vm.expectRevert(CustodyOracle.NotSignedByDevice.selector);
        _send(b);
    }

    function test_rejectsACheckpointNamingAnotherDevice() public {
        Bundle memory b = _bundle(W.WAREHOUSE_IN, W.ACCEPT_CUSTODY, false);
        b.cp = W.checkpoint(vm.addr(STRANGER_KEY), LOT, W.WAREHOUSE_IN, seq);
        b.deviceSig = W.sign(STRANGER_KEY, b.cp);
        b.att = W.attestation(b.cp, W.ACCEPT_CUSTODY, false);
        b.attestorSig = W.sign(ATTESTOR_KEY, b.att);
        vm.expectRevert(CustodyOracle.NotSignedByDevice.selector);
        _send(b);
    }

    function test_rejectsADecisionNotSignedByTheAttestor() public {
        Bundle memory b = _bundle(W.WAREHOUSE_IN, W.ACCEPT_CUSTODY, false);
        b.attestorSig = W.sign(STRANGER_KEY, b.att);
        vm.expectRevert(CustodyOracle.NotSignedByAttestor.selector);
        _send(b);
    }

    function test_rejectsADecisionMadeForAnotherCheckpoint() public {
        Bundle memory b = _bundle(W.WAREHOUSE_IN, W.ACCEPT_CUSTODY, false);
        b.att = W.attestation(W.checkpoint(device, LOT, W.WAREHOUSE_IN, seq + 1), W.ACCEPT_CUSTODY, false);
        b.attestorSig = W.sign(ATTESTOR_KEY, b.att);
        vm.expectRevert(CustodyOracle.AttestationMismatch.selector);
        _send(b);
    }

    function test_rejectsAReplayedCheckpoint() public {
        Bundle memory b = _bundle(W.WAREHOUSE_IN, W.ACCEPT_CUSTODY, false);
        _send(b);
        vm.expectRevert(abi.encodeWithSelector(CustodyOracle.StaleCheckpoint.selector, seq, seq));
        _send(b);
    }

    function test_rejectsAMalleatedSignature() public {
        Bundle memory b = _bundle(W.WAREHOUSE_IN, W.ACCEPT_CUSTODY, false);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(DEVICE_KEY, sha256(b.cp));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        b.deviceSig = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(Wire.BadSignature.selector);
        _send(b);
    }

    function test_rejectsMalformedPayloads() public {
        Bundle memory good = _bundle(W.WAREHOUSE_IN, W.ACCEPT_CUSTODY, false);

        Bundle memory b = _copy(good);
        b.cp = _truncate(good.cp, 220);
        vm.expectRevert(abi.encodeWithSelector(Wire.BadLength.selector, 221, 220));
        _send(b);

        b = _copy(good);
        b.cp = abi.encodePacked(bytes4("PPR1"), _tail(good.cp, 4));
        vm.expectRevert(abi.encodeWithSelector(Wire.BadMagic.selector, bytes4("PPC1"), bytes4("PPR1")));
        _send(b);

        b = _copy(good);
        b.att = _truncate(good.att, 109);
        vm.expectRevert(abi.encodeWithSelector(Wire.BadLength.selector, 110, 109));
        _send(b);

        b = _copy(good);
        b.deviceSig = _truncate(good.deviceSig, 64);
        vm.expectRevert(Wire.BadSignature.selector);
        _send(b);
    }

    function test_unknownLotReverts() public {
        Bundle memory b;
        b.cp = W.checkpoint(device, bytes32("LOT-99"), W.WAREHOUSE_IN, 20);
        b.deviceSig = W.sign(DEVICE_KEY, b.cp);
        b.att = W.attestation(b.cp, W.ACCEPT_CUSTODY, false);
        b.attestorSig = W.sign(ATTESTOR_KEY, b.att);
        vm.expectRevert(abi.encodeWithSelector(CustodyOracle.UnknownLot.selector, bytes32("LOT-99")));
        _send(b);
    }

    // --- breach, freeze, release -----------------------------------------------------------

    function _issueToAliceAndBob() internal {
        _toCustody();
        vm.startPrank(issuer);
        token.issue(alice, 70);
        token.issue(bob, 30);
        vm.stopPrank();
        _submit(W.WAREHOUSE_OUT, W.ACCEPT_CUSTODY);
    }

    function test_rejectWithSignedBreachFreezesEveryHolder() public {
        _issueToAliceAndBob();
        assertEq(uint8(_submitWithBreach(W.DOCK_HANDOFF, W.REJECT)), uint8(CustodyOracle.Outcome.FROZEN));

        CustodyOracle.Lot memory lot = oracle.getLot(LOT);
        assertEq(uint8(lot.state), uint8(CustodyOracle.LotState.FROZEN));
        assertTrue(lot.breachOpen);
        assertEq(token.getFrozenTokens(alice), 70);
        assertEq(token.getFrozenTokens(bob), 30);
        assertEq(token.balanceOf(alice), 0);
        assertEq(oracle.frozenUnits(LOT, alice), 70);
        assertEq(oracle.frozenUnits(LOT, bob), 30);
        assertEq(oracle.frozenHolderCount(LOT), 2);
        assertFalse(oracle.freezePending(LOT));

        CustodyOracle.Record[] memory history = oracle.getHistory(LOT, 2, 1);
        assertTrue(history[0].breachProven);
        assertEq(uint8(history[0].outcome), uint8(CustodyOracle.Outcome.FROZEN));
    }

    function test_rejectWithoutBreachRefusesButDoesNotFreeze() public {
        _issueToAliceAndBob();
        assertEq(uint8(_submit(W.DOCK_HANDOFF, W.REJECT)), uint8(CustodyOracle.Outcome.REFUSED));
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.IN_TRANSIT));
        assertEq(token.getFrozenTokens(alice), 0);
    }

    function test_modelCannotAcceptCustodyOverABreach() public {
        _issueToAliceAndBob();
        assertEq(
            uint8(_submitWithBreach(W.DOCK_HANDOFF, W.ACCEPT_CUSTODY)),
            uint8(CustodyOracle.Outcome.BLOCKED_BY_BREACH)
        );
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.IN_TRANSIT));
        assertTrue(oracle.getLot(LOT).breachOpen);

        // The breach stays on record: a later REJECT freezes without needing the evidence again.
        assertEq(uint8(_submit(W.DOCK_HANDOFF, W.REJECT)), uint8(CustodyOracle.Outcome.FROZEN));
        assertEq(token.getFrozenTokens(alice), 70);
    }

    function test_attestedBreachNeedsTheSignedReading() public {
        _toTransit();
        Bundle memory b = _bundle(W.DOCK_HANDOFF, W.REJECT, true);
        vm.expectRevert(CustodyOracle.BreachEvidenceMissing.selector);
        _send(b);
    }

    function test_breachEvidenceIsValidated() public {
        _toTransit();
        Bundle memory good = _bundle(W.DOCK_HANDOFF, W.REJECT, true);

        Bundle memory b = _withEvidence(_copy(good), W.reading(device, LOT, 425, 4550, seq - 1), DEVICE_KEY);
        vm.expectRevert(abi.encodeWithSelector(CustodyOracle.NotABreach.selector, int32(425), uint32(4550)));
        _send(b);

        b = _withEvidence(_copy(good), W.reading(device, bytes32("LOT-43"), 1260, 4550, seq - 1), DEVICE_KEY);
        vm.expectRevert(CustodyOracle.EvidenceNotForLot.selector);
        _send(b);

        b = _withEvidence(_copy(good), W.reading(device, LOT, 1260, 4550, seq - 1), STRANGER_KEY);
        vm.expectRevert(CustodyOracle.NotSignedByDevice.selector);
        _send(b);

        b = _withEvidence(_copy(good), W.reading(device, LOT, 1260, 4550, seq - 3), DEVICE_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(CustodyOracle.EvidenceOutsideWindow.selector, seq - 3, seq - 2, seq - 1)
        );
        _send(b);
    }

    function test_breachBoundsAreInclusive() public view {
        assertTrue(oracle.isInRange(LOT, 200, 2000));
        assertTrue(oracle.isInRange(LOT, 800, 7000));
        assertFalse(oracle.isInRange(LOT, 199, 4500));
        assertFalse(oracle.isInRange(LOT, 801, 4500));
        assertFalse(oracle.isInRange(LOT, -150, 4500));
        assertFalse(oracle.isInRange(LOT, 500, 1999));
        assertFalse(oracle.isInRange(LOT, 500, 7001));
    }

    function test_anyoneCanReportASignedBreach() public {
        _toTransit();
        bytes memory cold = W.reading(device, LOT, -150, 4550, seq + 1);
        vm.prank(makeAddr("anyone"));
        oracle.reportBreach(cold, W.sign(DEVICE_KEY, cold));
        assertTrue(oracle.getLot(LOT).breachOpen);
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.IN_TRANSIT), "a report alone does not freeze");

        assertEq(
            uint8(_submit(W.DOCK_HANDOFF, W.ACCEPT_CUSTODY)), uint8(CustodyOracle.Outcome.BLOCKED_BY_BREACH)
        );
    }

    function test_reportingAnInRangeReadingReverts() public {
        _toTransit();
        bytes memory fine = W.reading(device, LOT, 425, 4550, seq + 1);
        bytes memory sig = W.sign(DEVICE_KEY, fine);
        vm.expectRevert(abi.encodeWithSelector(CustodyOracle.NotABreach.selector, int32(425), uint32(4550)));
        oracle.reportBreach(fine, sig);
    }

    function test_inspectorReleasesAFrozenLot() public {
        _issueToAliceAndBob();
        _submitWithBreach(W.DOCK_HANDOFF, W.REJECT);

        vm.expectRevert(abi.encodeWithSelector(CustodyOracle.NotInspector.selector, issuer));
        vm.prank(issuer);
        oracle.release(LOT, keccak256("inspection report"), seq);

        vm.prank(inspector);
        oracle.release(LOT, keccak256("inspection report"), seq + 5);

        CustodyOracle.Lot memory lot = oracle.getLot(LOT);
        assertEq(uint8(lot.state), uint8(CustodyOracle.LotState.IN_CUSTODY));
        assertFalse(lot.breachOpen);
        assertEq(lot.clearedSeq, seq + 5);
        assertEq(token.getFrozenTokens(alice), 0);
        assertEq(token.balanceOf(alice), 70);
        assertEq(oracle.frozenHolderCount(LOT), 0);
        vm.prank(alice);
        token.transfer(bob, 5); // tradable again

        CustodyOracle.Record[] memory history = oracle.getHistory(LOT, oracle.historyLength(LOT) - 1, 1);
        assertEq(uint8(history[0].outcome), uint8(CustodyOracle.Outcome.RELEASED));
        assertEq(history[0].checkpointDigest, keccak256("inspection report"));
    }

    function test_clearedReadingsCannotReopenABreach() public {
        _issueToAliceAndBob();
        _submitWithBreach(W.DOCK_HANDOFF, W.REJECT);
        bytes memory oldWarm = W.reading(device, LOT, 1260, 4550, seq - 1);
        bytes memory sig = W.sign(DEVICE_KEY, oldWarm);
        vm.prank(inspector);
        oracle.release(LOT, keccak256("inspection report"), seq);

        vm.expectRevert(abi.encodeWithSelector(CustodyOracle.EvidenceAlreadyCleared.selector, seq - 1, seq));
        oracle.reportBreach(oldWarm, sig);
    }

    function test_nothingToReleaseReverts() public {
        _toCustody();
        vm.prank(inspector);
        vm.expectRevert(abi.encodeWithSelector(CustodyOracle.NothingToRelease.selector, LOT));
        oracle.release(LOT, bytes32(0), 0);
    }

    function test_aFrozenLotAcceptsNoCustodyUntilReleased() public {
        _issueToAliceAndBob();
        _submitWithBreach(W.DOCK_HANDOFF, W.REJECT);
        Bundle memory b = _bundle(W.DOCK_HANDOFF, W.ACCEPT_CUSTODY, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustodyOracle.InvalidTransition.selector,
                CustodyOracle.LotState.FROZEN,
                W.DOCK_HANDOFF,
                W.ACCEPT_CUSTODY
            )
        );
        _send(b);
    }

    function test_freezeIsDeferredWhenTheTokenRefusesIt() public {
        _issueToAliceAndBob();
        token.setFailFreeze(true); // e.g. the issuer paused the token
        assertEq(uint8(_submitWithBreach(W.DOCK_HANDOFF, W.REJECT)), uint8(CustodyOracle.Outcome.FROZEN));

        // The lot is frozen regardless: the compliance hook blocks every move.
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.FROZEN));
        assertTrue(oracle.freezePending(LOT));
        assertEq(token.getFrozenTokens(alice), 0);
        vm.prank(alice);
        vm.expectRevert(bytes("compliance: transfer"));
        token.transfer(bob, 1);

        token.setFailFreeze(false);
        oracle.continueFreeze(LOT);
        assertFalse(oracle.freezePending(LOT));
        assertEq(token.getFrozenTokens(alice), 70);
        assertEq(token.getFrozenTokens(bob), 30);
    }

    function test_freezesAndUnfreezesManyHoldersInPages() public {
        _toCustody();
        uint256 holders = 120;
        vm.startPrank(issuer);
        for (uint256 i = 0; i < holders; i++) {
            token.issue(address(uint160(0x1000 + i)), 1);
        }
        vm.stopPrank();
        _submit(W.WAREHOUSE_OUT, W.ACCEPT_CUSTODY);
        _submitWithBreach(W.DOCK_HANDOFF, W.REJECT);

        assertEq(oracle.frozenHolderCount(LOT), 50);
        assertTrue(oracle.freezePending(LOT));
        oracle.continueFreeze(LOT);
        oracle.continueFreeze(LOT);
        assertEq(oracle.frozenHolderCount(LOT), 120);
        assertFalse(oracle.freezePending(LOT));

        vm.prank(inspector);
        oracle.release(LOT, bytes32("report"), seq);
        assertEq(oracle.frozenHolderCount(LOT), 70);
        oracle.continueUnfreeze(LOT);
        oracle.continueUnfreeze(LOT);
        assertEq(oracle.frozenHolderCount(LOT), 0);
        assertEq(token.getFrozenTokens(address(0x1000)), 0);
        assertEq(token.balanceOf(address(0x1000 + 119)), 1);
    }

    function test_continueFreezeNeedsAFrozenLot() public {
        _toCustody();
        vm.expectRevert(abi.encodeWithSelector(CustodyOracle.NotFrozen.selector, LOT));
        oracle.continueFreeze(LOT);
    }

    // --- parties ---------------------------------------------------------------------------

    function test_registrarCanRotateTheDevice() public {
        address newDevice = vm.addr(STRANGER_KEY);
        vm.expectRevert(abi.encodeWithSelector(CustodyOracle.NotRegistrar.selector, address(this)));
        oracle.setLotParties(LOT, newDevice, attestor, inspector);

        vm.prank(issuer);
        oracle.setLotParties(LOT, newDevice, attestor, inspector);

        // The old device is no longer accepted...
        Bundle memory old = _bundle(W.WAREHOUSE_IN, W.ACCEPT_CUSTODY, false);
        vm.expectRevert(CustodyOracle.NotSignedByDevice.selector);
        _send(old);

        // ...and the new one is.
        Bundle memory b;
        b.cp = W.checkpoint(newDevice, LOT, W.WAREHOUSE_IN, seq);
        b.deviceSig = W.sign(STRANGER_KEY, b.cp);
        b.att = W.attestation(b.cp, W.ACCEPT_CUSTODY, false);
        b.attestorSig = W.sign(ATTESTOR_KEY, b.att);
        _send(b);
        assertEq(uint8(_state()), uint8(CustodyOracle.LotState.IN_CUSTODY));
    }

    // --- byte helpers ----------------------------------------------------------------------

    function _copy(Bundle memory b) internal pure returns (Bundle memory) {
        return Bundle(b.cp, b.deviceSig, b.att, b.attestorSig, b.reading, b.readingSig);
    }

    function _truncate(bytes memory data, uint256 length) internal pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = data[i];
        }
    }

    function _tail(bytes memory data, uint256 from) internal pure returns (bytes memory out) {
        out = new bytes(data.length - from);
        for (uint256 i = from; i < data.length; i++) {
            out[i - from] = data[i];
        }
    }
}
