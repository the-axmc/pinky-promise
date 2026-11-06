// Geofence proof for a device-signed reading (PPR1, see packages/protocol/src/reading.ts).
//
// Statement proven, without revealing the coordinates:
//
//   "The device with this public key signed a reading with this digest, and the GPS position
//    committed to inside that reading lies within this bounding box."
//
// Public inputs : digest, device public key (x, y), the venue's box.
// Private inputs: the reading payload, the device signature, the position and the salt.
//
// What this buys is privacy, not anti-spoofing: a device fed fake GPS still produces a valid
// proof. Authenticity of place comes from the venue anchor (see packages/protocol/src/anchor.ts).
//
// The two SHA-256 computations are over fixed lengths (40 and 144 bytes), so the padding is laid
// out by hand around the compression function instead of pulling in a hashing dependency.

use std::hash::sha256_compression;

// SHA-256 initial hash value.
global IV: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

// Byte offset of gps_commitment inside the 144-byte reading payload.
global GPS_OFFSET: u32 = 64;

fn block_words(block: [u8; 64]) -> [u32; 16] {
    let mut words: [u32; 16] = [0; 16];
    for i in 0..16 {
        words[i] = ((block[4 * i] as u32) << 24)
            | ((block[4 * i + 1] as u32) << 16)
            | ((block[4 * i + 2] as u32) << 8)
            | (block[4 * i + 3] as u32);
    }
    words
}

fn state_bytes(state: [u32; 8]) -> [u8; 32] {
    let mut out: [u8; 32] = [0; 32];
    for i in 0..8 {
        out[4 * i] = (state[i] >> 24) as u8;
        out[4 * i + 1] = (state[i] >> 16) as u8;
        out[4 * i + 2] = (state[i] >> 8) as u8;
        out[4 * i + 3] = state[i] as u8;
    }
    out
}

// SHA-256 of exactly 40 bytes: one padded block.
fn sha256_40(message: [u8; 40]) -> [u8; 32] {
    let mut block: [u8; 64] = [0; 64];
    for i in 0..40 {
        block[i] = message[i];
    }
    block[40] = 0x80;
    // Message length in bits, 320 = 0x0140, big-endian in the last 8 bytes.
    block[62] = 0x01;
    block[63] = 0x40;
    state_bytes(sha256_compression(block_words(block), IV))
}

// SHA-256 of exactly 144 bytes: three padded blocks.
fn sha256_144(message: [u8; 144]) -> [u8; 32] {
    let mut padded: [u8; 192] = [0; 192];
    for i in 0..144 {
        padded[i] = message[i];
    }
    padded[144] = 0x80;
    // Message length in bits, 1152 = 0x0480.
    padded[190] = 0x04;
    padded[191] = 0x80;
    let mut state = IV;
    for b in 0..3 {
        let mut block: [u8; 64] = [0; 64];
        for i in 0..64 {
            block[i] = padded[64 * b + i];
        }
        state = sha256_compression(block_words(block), state);
    }
    state_bytes(state)
}

fn main(
    // --- public ---
    digest: pub [u8; 32],
    pubkey_x: pub [u8; 32],
    pubkey_y: pub [u8; 32],
    lat_min: pub u32,
    lat_max: pub u32,
    lon_min: pub u32,
    lon_max: pub u32,
    // --- private ---
    payload: [u8; 144],
    signature: [u8; 64],
    lat: u32,
    lon: u32,
    salt: [u8; 32],
) {
    // 1. It is a reading payload ("PPR1"), not some other message the device signed.
    assert(payload[0] == 0x50);
    assert(payload[1] == 0x50);
    assert(payload[2] == 0x52);
    assert(payload[3] == 0x31);

    // 2. The private position and salt open the commitment: SHA-256(lat ‖ lon ‖ salt).
    let mut preimage: [u8; 40] = [0; 40];
    preimage[0] = (lat >> 24) as u8;
    preimage[1] = (lat >> 16) as u8;
    preimage[2] = (lat >> 8) as u8;
    preimage[3] = lat as u8;
    preimage[4] = (lon >> 24) as u8;
    preimage[5] = (lon >> 16) as u8;
    preimage[6] = (lon >> 8) as u8;
    preimage[7] = lon as u8;
    for i in 0..32 {
        preimage[8 + i] = salt[i];
    }
    let commitment = sha256_40(preimage);

    // 3. That commitment is the one inside the payload.
    for i in 0..32 {
        assert(payload[GPS_OFFSET + i] == commitment[i]);
    }

    // 4. The payload hashes to the public digest.
    assert(sha256_144(payload) == digest);

    // 5. The device signed that digest.
    assert(std::ecdsa_secp256k1::verify_signature(pubkey_x, pubkey_y, signature, digest));

    // 6. The position is inside the venue's box (bounds inclusive).
    assert(lat >= lat_min);
    assert(lat <= lat_max);
    assert(lon >= lon_min);
    assert(lon <= lon_max);
}
