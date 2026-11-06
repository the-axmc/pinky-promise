// The secp256k1 key that lives in the ESP32's flash (NVS): the device wallet on a device, the
// anchor's signing key on an anchor. It is generated on first boot and never leaves the board;
// the host only ever sees the public key and r || s signatures.
//
// NVS is not encrypted unless flash encryption is enabled, so this key is as safe as the board
// is. That is the plan's accepted fallback; the ATECC608B is the root that cannot be copied.
#pragma once

#include <Arduino.h>
#include <Preferences.h>
#include <uECC.h>
#if __has_include(<esp_random.h>)
#include <esp_random.h>
#else
#include <esp_system.h>
#endif
#if __has_include("bootloader_random.h")
#include "bootloader_random.h"
#define PINKY_BOOT_ENTROPY 1
#else
#define PINKY_BOOT_ENTROPY 0
#endif
#include "util.h"

#define PINKY_NVS "pinky"

static uint8_t g_walletPriv[32];
static uint8_t g_walletPub[64];
static bool g_walletReady = false;
static uint8_t g_rngPool[32];
static uint32_t g_rngCounter = 0;

// micro-ecc asks this for the ECDSA nonce. A predictable nonce gives the private key away, so
// the answer is never the hardware generator alone: every block is
// SHA-256(pool || private key || counter || hardware random), and the pool is stirred with the
// digest being signed. Even a stuck hardware generator then yields nonces that are unique per
// message and unknown to anyone without the key.
static int walletRng(uint8_t *dest, unsigned size) {
  while (size > 0) {
    uint8_t block[32 + 32 + 4 + 32];
    memcpy(block, g_rngPool, 32);
    memcpy(block + 32, g_walletPriv, 32);
    g_rngCounter++;
    memcpy(block + 64, &g_rngCounter, 4);
    esp_fill_random(block + 68, 32);
    uint8_t out[32];
    sha256Of(block, sizeof(block), out);
    uint8_t next[64];
    memcpy(next, g_rngPool, 32);
    memcpy(next + 32, out, 32);
    sha256Of(next, sizeof(next), g_rngPool);
    unsigned take = size < 32 ? size : 32;
    memcpy(dest, out, take);
    dest += take;
    size -= take;
  }
  return 1;
}

// Loads the key, or creates it on the first boot.
static bool walletBegin() {
  uECC_set_rng(&walletRng);
  Preferences prefs;
  prefs.begin(PINKY_NVS, false);
  bool ok = false;
  if (prefs.getBytesLength("wallet") == 32) {
    prefs.getBytes("wallet", g_walletPriv, 32);
    ok = uECC_compute_public_key(g_walletPriv, g_walletPub, uECC_secp256k1()) == 1;
  } else {
#if PINKY_BOOT_ENTROPY
    // Without the radio on, the hardware generator needs this entropy source to be truly random.
    bootloader_random_enable();
#endif
    esp_fill_random(g_rngPool, 32);
    ok = uECC_make_key(g_walletPub, g_walletPriv, uECC_secp256k1()) == 1;
#if PINKY_BOOT_ENTROPY
    bootloader_random_disable();
#endif
    if (ok) ok = prefs.putBytes("wallet", g_walletPriv, 32) == 32;
  }
  prefs.end();
  g_walletReady = ok;
  return ok;
}

// Signs a 32-byte digest: r || s, 64 bytes. s is not normalised and there is no recovery byte;
// the host takes care of both.
static bool walletSign(const uint8_t digest[32], uint8_t signature[64]) {
  if (!g_walletReady) return false;
  uint8_t mix[64];
  memcpy(mix, g_rngPool, 32);
  memcpy(mix + 32, digest, 32);
  sha256Of(mix, sizeof(mix), g_rngPool);
  return uECC_sign(g_walletPriv, digest, 32, signature, uECC_secp256k1()) == 1;
}

#if PINKY_IS_ANCHOR
// ---- venue anchor ---------------------------------------------------------------------------
// The anchor co-signs a device's nonce. PPA1, 96 bytes (see packages/protocol/src/anchor.ts):
//
//   0   4  "PPA1"
//   4  32  venue_id, ASCII, zero-padded
//  36  20  device address
//  56  32  blockhash (the nonce)
//  88   8  counter, big-endian, never reused
//
// signature = secp256k1 over SHA-256(payload).

static String g_venueId;
static uint64_t g_anchorCounter = 0;

static void anchorBegin() {
  Preferences prefs;
  prefs.begin(PINKY_NVS, false);
  g_venueId = prefs.getString("venue", "");
  g_anchorCounter = prefs.getULong64("counter", 0);
  prefs.end();
}

static bool validVenueId(const char *id) {
  size_t length = id == nullptr ? 0 : strlen(id);
  if (length == 0 || length > 32) return false;
  for (size_t i = 0; i < length; i++) {
    char c = id[i];
    bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
    if (!ok) return false;
  }
  return true;
}

static bool anchorConfigure(const char *venueId) {
  if (!validVenueId(venueId)) return false;
  Preferences prefs;
  prefs.begin(PINKY_NVS, false);
  prefs.putString("venue", venueId);
  prefs.end();
  g_venueId = venueId;
  return true;
}

// Returns nullptr on success, or what went wrong.
static const char *anchorAttest(const uint8_t device[20], const uint8_t blockhash[32], uint8_t payload[96], uint8_t signature[64]) {
  if (g_venueId.length() == 0) return "anchor has no venue configured";
  // The counter is stored before it is used, so a power cut can skip a value but never repeat one.
  g_anchorCounter++;
  Preferences prefs;
  prefs.begin(PINKY_NVS, false);
  prefs.putULong64("counter", g_anchorCounter);
  prefs.end();

  memset(payload, 0, 96);
  memcpy(payload, "PPA1", 4);
  memcpy(payload + 4, g_venueId.c_str(), g_venueId.length());
  memcpy(payload + 36, device, 20);
  memcpy(payload + 56, blockhash, 32);
  for (int i = 0; i < 8; i++) payload[88 + i] = (uint8_t)(g_anchorCounter >> (8 * (7 - i)));

  uint8_t digest[32];
  sha256Of(payload, 96, digest);
  if (!walletSign(digest, signature)) return "anchor signing failed";
  return nullptr;
}
#endif // PINKY_IS_ANCHOR
