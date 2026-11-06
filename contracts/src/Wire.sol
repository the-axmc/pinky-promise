// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Wire
/// @notice Decoders for the signed messages the device and the gateway produce, and the
///         signature check they share. Layouts are specified in packages/protocol (reading.ts,
///         checkpoint.ts, attestation.ts) and pinned by contracts/vectors/protocol-v1.json.
/// @dev Every message is a fixed-width big-endian payload starting with a 4-byte magic. Its
///      digest is SHA-256(payload) and signatures are 65-byte `r | s | v` secp256k1 signatures
///      over that digest, with no prefix.
library Wire {
    bytes4 internal constant READING_MAGIC = "PPR1";
    bytes4 internal constant CHECKPOINT_MAGIC = "PPC1";
    bytes4 internal constant ATTESTATION_MAGIC = "PPX1";

    uint256 internal constant READING_LENGTH = 144;
    uint256 internal constant CHECKPOINT_LENGTH = 221;
    uint256 internal constant ATTESTATION_LENGTH = 110;

    /// @dev Half the secp256k1 group order: a signature with s above it is the malleable twin.
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    struct Reading {
        address device;
        bytes32 assetId;
        int32 tempCenti;
        uint32 rhCenti;
        bytes32 gpsCommitment;
        uint64 ts;
        uint64 seq;
        bytes32 anchorBlockhash;
    }

    struct Checkpoint {
        address device;
        bytes32 assetId;
        uint8 kind;
        uint64 ts;
        uint64 seq;
        uint64 firstSeq;
        uint64 lastSeq;
        uint32 readingCount;
        bytes32 readingsRoot;
        bytes32 sealHash;
        bytes32 anchorDigest;
        bytes32 anchorBlockhash;
    }

    struct Attestation {
        bytes32 checkpointDigest;
        uint8 decision;
        bool breach;
        bytes32 requestIdHash;
        bytes32 episodeRoot;
        uint64 decidedAt;
    }

    error BadLength(uint256 expected, uint256 actual);
    error BadMagic(bytes4 expected, bytes4 actual);
    error BadField(string field);
    error BadSignature();

    function decodeReading(bytes calldata p) internal pure returns (Reading memory r) {
        _expect(p, READING_LENGTH, READING_MAGIC);
        r.device = address(bytes20(p[4:24]));
        r.assetId = bytes32(p[24:56]);
        r.tempCenti = int32(uint32(bytes4(p[56:60])));
        r.rhCenti = uint32(bytes4(p[60:64]));
        r.gpsCommitment = bytes32(p[64:96]);
        r.ts = uint64(bytes8(p[96:104]));
        r.seq = uint64(bytes8(p[104:112]));
        r.anchorBlockhash = bytes32(p[112:144]);
    }

    function decodeCheckpoint(bytes calldata p) internal pure returns (Checkpoint memory c) {
        _expect(p, CHECKPOINT_LENGTH, CHECKPOINT_MAGIC);
        c.device = address(bytes20(p[4:24]));
        c.assetId = bytes32(p[24:56]);
        c.kind = uint8(p[56]);
        c.ts = uint64(bytes8(p[57:65]));
        c.seq = uint64(bytes8(p[65:73]));
        c.firstSeq = uint64(bytes8(p[73:81]));
        c.lastSeq = uint64(bytes8(p[81:89]));
        c.readingCount = uint32(bytes4(p[89:93]));
        c.readingsRoot = bytes32(p[93:125]);
        c.sealHash = bytes32(p[125:157]);
        c.anchorDigest = bytes32(p[157:189]);
        c.anchorBlockhash = bytes32(p[189:221]);
        if (c.kind < 1 || c.kind > 4) revert BadField("kind");
        if (c.readingCount == 0) revert BadField("reading_count");
        if (c.firstSeq > c.lastSeq) revert BadField("first_seq");
        if (c.seq <= c.lastSeq) revert BadField("seq");
    }

    function decodeAttestation(bytes calldata p) internal pure returns (Attestation memory a) {
        _expect(p, ATTESTATION_LENGTH, ATTESTATION_MAGIC);
        a.checkpointDigest = bytes32(p[4:36]);
        a.decision = uint8(p[36]);
        uint8 breach = uint8(p[37]);
        a.requestIdHash = bytes32(p[38:70]);
        a.episodeRoot = bytes32(p[70:102]);
        a.decidedAt = uint64(bytes8(p[102:110]));
        if (a.decision > 3) revert BadField("decision");
        if (breach > 1) revert BadField("breach");
        a.breach = breach == 1;
    }

    /// @notice Recovers the signer of `digest`. Reverts unless `sig` is a well-formed, low-s,
    ///         65-byte `r | s | v` signature that recovers to a non-zero address.
    function recover(bytes32 digest, bytes calldata sig) internal pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }

    function _expect(bytes calldata p, uint256 length, bytes4 magic) private pure {
        if (p.length != length) revert BadLength(length, p.length);
        if (bytes4(p[0:4]) != magic) revert BadMagic(magic, bytes4(p[0:4]));
    }
}
