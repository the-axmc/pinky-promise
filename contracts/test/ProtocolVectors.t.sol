// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CustodyOracle} from "../src/CustodyOracle.sol";
import {Wire} from "../src/Wire.sol";
import {MockAtsToken} from "./utils/MockAtsToken.sol";
import {WireBuilder as W} from "./utils/WireBuilder.sol";

/// @dev Exposes the calldata decoders so tests can call them on vector payloads.
contract WireHarness {
    function decodeReading(bytes calldata payload) external pure returns (Wire.Reading memory) {
        return Wire.decodeReading(payload);
    }

    function decodeCheckpoint(bytes calldata payload) external pure returns (Wire.Checkpoint memory) {
        return Wire.decodeCheckpoint(payload);
    }

    function decodeAttestation(bytes calldata payload) external pure returns (Wire.Attestation memory) {
        return Wire.decodeAttestation(payload);
    }

    function recover(bytes32 digest, bytes calldata sig) external pure returns (address) {
        return Wire.recover(digest, sig);
    }
}

/// @notice Checks the contract against contracts/vectors/protocol-v1.json, which the TypeScript
///         protocol package generates. If these pass, a message the device simulator or the
///         gateway signs is read by the contract exactly as intended, and the on-chain state
///         machine is the same function as the one the gateway and the UI use.
contract ProtocolVectorsTest is Test {
    // Field order is alphabetical: that is how Foundry lays out a decoded JSON object.
    struct PolicyRow {
        bool breachOpen;
        bool breachOpenAfter;
        bool breachProven;
        uint256 decision;
        uint256 kind;
        uint256 next;
        bool ok;
        uint256 outcome;
        uint256 state;
    }

    string internal json;
    WireHarness internal wire;
    CustodyOracle internal oracle;
    MockAtsToken internal token;
    address internal issuer = makeAddr("issuer");
    address internal inspector = makeAddr("inspector");
    address internal device;
    uint256 internal deviceKey;
    bytes32 internal lotId;

    function setUp() public {
        vm.warp(1_793_966_400);
        json = vm.readFile("vectors/protocol-v1.json");
        wire = new WireHarness();
        oracle = new CustodyOracle();
        token = new MockAtsToken(issuer, address(oracle));

        device = vm.parseJsonAddress(json, ".keys.device.address");
        deviceKey = uint256(vm.parseJsonBytes32(json, ".keys.device.secret"));
        lotId = vm.parseJsonBytes32(json, ".lot.assetIdBytes32");

        vm.prank(issuer);
        oracle.registerLot(
            CustodyOracle.LotConfig({
                lotId: lotId,
                token: address(token),
                device: device,
                attestor: vm.parseJsonAddress(json, ".keys.attestor.address"),
                inspector: inspector,
                tempMinCenti: int32(vm.parseJsonInt(json, ".lot.thresholds.tempMinCenti")),
                tempMaxCenti: int32(vm.parseJsonInt(json, ".lot.thresholds.tempMaxCenti")),
                rhMinCenti: uint32(vm.parseJsonUint(json, ".lot.thresholds.rhMinCenti")),
                rhMaxCenti: uint32(vm.parseJsonUint(json, ".lot.thresholds.rhMaxCenti"))
            })
        );
    }

    function test_testKeysMatch() public view {
        assertEq(vm.addr(deviceKey), device, "the vector device key and address belong together");
        assertEq(lotId, bytes32("LOT-42"));
    }

    function test_policyTableMatchesTypeScript() public view {
        PolicyRow[] memory rows = abi.decode(vm.parseJson(json, ".policy"), (PolicyRow[]));
        assertEq(rows.length, 384, "6 states x 2 x 4 kinds x 4 decisions x 2");
        for (uint256 i = 0; i < rows.length; i++) {
            PolicyRow memory row = rows[i];
            (bool ok, CustodyOracle.Outcome outcome, CustodyOracle.LotState next, bool breachOpenAfter) = oracle.previewCheckpoint(
                CustodyOracle.LotState(row.state),
                row.breachOpen,
                uint8(row.kind),
                uint8(row.decision),
                row.breachProven
            );
            string memory label = string.concat("policy row ", vm.toString(i));
            assertEq(ok, row.ok, label);
            assertEq(uint256(outcome), row.outcome, label);
            assertEq(uint256(next), row.next, label);
            assertEq(breachOpenAfter, row.breachOpenAfter, label);
        }
    }

    function test_decodesTypeScriptReadings() public view {
        for (uint256 i = 0; i < 5; i++) {
            string memory at = string.concat(".readings[", vm.toString(i), "]");
            bytes memory payload = vm.parseJsonBytes(json, string.concat(at, ".payload"));
            Wire.Reading memory reading = wire.decodeReading(payload);

            assertEq(reading.device, device);
            assertEq(reading.assetId, lotId);
            assertEq(int256(reading.tempCenti), vm.parseJsonInt(json, string.concat(at, ".fields.tempCenti")));
            assertEq(uint256(reading.rhCenti), vm.parseJsonUint(json, string.concat(at, ".fields.rhCenti")));
            assertEq(uint256(reading.seq), vm.parseJsonUint(json, string.concat(at, ".fields.seq")));
            assertEq(uint256(reading.ts), vm.parseJsonUint(json, string.concat(at, ".fields.ts")));
            assertEq(reading.gpsCommitment, vm.parseJsonBytes32(json, ".gps.commitment"));

            assertEq(sha256(payload), vm.parseJsonBytes32(json, string.concat(at, ".digest")), "digest");
            assertEq(
                wire.recover(sha256(payload), vm.parseJsonBytes(json, string.concat(at, ".sig"))),
                device,
                "signer"
            );
            assertEq(
                oracle.isInRange(lotId, reading.tempCenti, reading.rhCenti),
                vm.parseJsonBool(json, string.concat(at, ".inRange")),
                "breach boundary"
            );
        }
    }

    function test_decodesTypeScriptCheckpointAndAttestation() public view {
        bytes memory cpPayload = vm.parseJsonBytes(json, ".checkpoint.payload");
        Wire.Checkpoint memory cp = wire.decodeCheckpoint(cpPayload);
        assertEq(cp.device, device);
        assertEq(cp.assetId, lotId);
        assertEq(cp.kind, W.DOCK_HANDOFF);
        assertEq(uint256(cp.seq), vm.parseJsonUint(json, ".checkpoint.fields.seq"));
        assertEq(uint256(cp.firstSeq), vm.parseJsonUint(json, ".checkpoint.fields.firstSeq"));
        assertEq(uint256(cp.lastSeq), vm.parseJsonUint(json, ".checkpoint.fields.lastSeq"));
        assertEq(uint256(cp.readingCount), 5);
        assertEq(cp.readingsRoot, vm.parseJsonBytes32(json, ".checkpoint.fields.readingsRoot"));
        assertEq(cp.photoHash, vm.parseJsonBytes32(json, ".checkpoint.fields.photoHash"));
        assertEq(cp.anchorDigest, vm.parseJsonBytes32(json, ".anchor.digest"));
        assertEq(sha256(cpPayload), vm.parseJsonBytes32(json, ".checkpoint.digest"));

        Wire.Attestation memory att = wire.decodeAttestation(vm.parseJsonBytes(json, ".attestation.payload"));
        assertEq(att.checkpointDigest, sha256(cpPayload));
        assertEq(att.decision, W.REJECT);
        assertTrue(att.breach);
        assertEq(att.requestIdHash, sha256(bytes(vm.parseJsonString(json, ".attestation.requestId"))));
        assertEq(att.episodeRoot, vm.parseJsonBytes32(json, ".attestation.fields.episodeRoot"));
    }

    /// The end-to-end claim: a checkpoint, a decision and breach evidence produced entirely by
    /// the TypeScript code freeze the lot on chain.
    function test_typeScriptSignedBreachFreezesTheLot() public {
        // Two Solidity-built checkpoints (same device key) take the lot to IN_TRANSIT first.
        _accept(W.WAREHOUSE_IN, 2);
        vm.prank(issuer);
        token.issue(makeAddr("holder"), 100);
        _accept(W.WAREHOUSE_OUT, 4);

        CustodyOracle.Outcome outcome = oracle.submitCheckpoint(
            vm.parseJsonBytes(json, ".checkpoint.payload"),
            vm.parseJsonBytes(json, ".checkpoint.sig"),
            vm.parseJsonBytes(json, ".attestation.payload"),
            vm.parseJsonBytes(json, ".attestation.sig"),
            vm.parseJsonBytes(json, ".readings[2].payload"), // "too warm", seq 7, inside window 5..9
            vm.parseJsonBytes(json, ".readings[2].sig")
        );
        assertEq(uint8(outcome), uint8(CustodyOracle.Outcome.FROZEN));
        assertEq(uint8(oracle.getLot(lotId).state), uint8(CustodyOracle.LotState.FROZEN));
        assertEq(token.getFrozenTokens(makeAddr("holder")), 100);

        CustodyOracle.Record[] memory history = oracle.getHistory(lotId, 2, 1);
        assertEq(history[0].checkpointDigest, vm.parseJsonBytes32(json, ".checkpoint.digest"));
        assertEq(history[0].episodeRoot, vm.parseJsonBytes32(json, ".attestation.fields.episodeRoot"));
    }

    function test_typeScriptSignedNegativeTemperatureIsABreach() public {
        _accept(W.WAREHOUSE_IN, 2);
        oracle.reportBreach(
            vm.parseJsonBytes(json, ".readings[3].payload"), // "too cold (negative)": -1.50 C
            vm.parseJsonBytes(json, ".readings[3].sig")
        );
        assertTrue(oracle.getLot(lotId).breachOpen);
    }

    function _accept(uint8 kind, uint64 seq) internal {
        bytes memory cp = W.checkpoint(device, lotId, kind, seq);
        bytes memory att = W.attestation(cp, W.ACCEPT_CUSTODY, false);
        bytes memory deviceSig = W.sign(deviceKey, cp);
        bytes memory attestorSig = W.sign(uint256(vm.parseJsonBytes32(json, ".keys.attestor.secret")), att);
        oracle.submitCheckpoint(cp, deviceSig, att, attestorSig, "", "");
    }
}
