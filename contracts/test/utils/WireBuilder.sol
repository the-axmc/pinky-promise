// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @notice Builds and signs the wire messages in Solidity, the way a device and a gateway would,
///         so tests can script arbitrary scenarios. Layouts follow packages/protocol.
library WireBuilder {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint8 internal constant WAREHOUSE_IN = 1;
    uint8 internal constant WAREHOUSE_OUT = 2;
    uint8 internal constant DOCK_HANDOFF = 3;
    uint8 internal constant FINAL_DELIVERY = 4;

    uint8 internal constant PENDING = 0;
    uint8 internal constant ACCEPT_CUSTODY = 1;
    uint8 internal constant REJECT = 2;
    uint8 internal constant ESCALATE = 3;

    function reading(address device, bytes32 lotId, int32 tempCenti, uint32 rhCenti, uint64 seq)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            bytes4("PPR1"),
            device,
            lotId,
            tempCenti,
            rhCenti,
            keccak256("gps commitment"),
            uint64(1_793_966_400) + seq * 30,
            seq,
            keccak256("anchor block")
        );
    }

    /// @dev A checkpoint whose window is the two seqs just before it.
    function checkpoint(address device, bytes32 lotId, uint8 kind, uint64 seq)
        internal
        pure
        returns (bytes memory)
    {
        return checkpoint(device, lotId, kind, seq, seq - 2, seq - 1);
    }

    function checkpoint(
        address device,
        bytes32 lotId,
        uint8 kind,
        uint64 seq,
        uint64 firstSeq,
        uint64 lastSeq
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            bytes4("PPC1"),
            device,
            lotId,
            kind,
            uint64(1_793_966_400) + seq * 30,
            seq,
            firstSeq,
            lastSeq,
            uint32(lastSeq - firstSeq + 1),
            keccak256("readings root"),
            keccak256("seal photo"),
            bytes32(0),
            keccak256("anchor block")
        );
    }

    function attestation(bytes memory checkpointPayload, uint8 decision, bool breach)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            bytes4("PPX1"),
            sha256(checkpointPayload),
            decision,
            breach ? uint8(1) : uint8(0),
            sha256("0852f405-6c56-40c2-a800-e6fd70785065"),
            keccak256("episode root"),
            uint64(1_793_966_430)
        );
    }

    /// @dev 65-byte r | s | v signature over SHA-256(payload), as the protocol specifies.
    function sign(uint256 privateKey, bytes memory payload) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, sha256(payload));
        return abi.encodePacked(r, s, v);
    }
}
