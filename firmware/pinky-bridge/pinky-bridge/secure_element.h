// ATECC608B: the hardware root of trust. Its P-256 key is generated inside the chip, in slot 0,
// and cannot be read out; the chip signs the device certificate with it once, at enrolment.
//
// A chip fresh from the bag is blank and unlocked. It has to be provisioned ONCE, and that step
// is irreversible: the configuration and the key are locked for the life of the chip. It only
// ever happens on an explicit `se.provision` with confirm "LOCK-FOREVER" — never on its own.
#pragma once

#include <Arduino.h>
#include <Wire.h>
#include "config.h"
#include "util.h"

#if PINKY_HAS_ATECC && !PINKY_IS_ANCHOR
#include <SparkFun_ATECCX08a_Arduino_Library.h>

static ATECCX08A g_atecc;
static NullStream g_ateccLog;
static bool g_ateccPresent = false;

static void ateccBegin() {
  if (PIN_I2C_SDA < 0) return;
  g_ateccPresent = g_atecc.begin(ATECC_ADDRESS, Wire, g_ateccLog);
  if (g_ateccPresent) g_atecc.readConfigZone(false);
}

static bool ateccLocked() { return g_atecc.configLockStatus && g_atecc.dataOTPLockStatus && g_atecc.slot0LockStatus; }

// serial: 9 bytes. publicKey: 64 bytes, x || y. Returns nullptr on success.
static const char *ateccInfo(uint8_t serial[9], uint8_t publicKey[64]) {
  if (!g_ateccPresent) return "unsupported";
  if (!g_atecc.readConfigZone(false)) return "atecc608b not answering";
  if (!ateccLocked()) return "atecc608b not provisioned";
  if (!g_atecc.generatePublicKey(0, false)) return "atecc608b could not derive the public key";
  memcpy(serial, g_atecc.serialNumber, 9);
  memcpy(publicKey, g_atecc.publicKey64Bytes, 64);
  return nullptr;
}

// Signs a 32-byte digest with the key in slot 0: r || s, 64 bytes.
static const char *ateccSign(const uint8_t digest[32], uint8_t signature[64]) {
  if (!g_ateccPresent) return "unsupported";
  if (!ateccLocked()) return "atecc608b not provisioned";
  uint8_t message[32];
  memcpy(message, digest, 32);
  if (!g_atecc.createSignature(message, 0)) return "atecc608b signing failed";
  memcpy(signature, g_atecc.signature, 64);
  return nullptr;
}

// IRREVERSIBLE. The same five steps as SparkFun's "Example1_Configuration", each skipped if a
// previous attempt already completed it, so an interrupted run can be resumed.
static const char *ateccProvision() {
  if (!g_ateccPresent) return "unsupported";
  if (!g_atecc.readConfigZone(false)) return "atecc608b not answering";
  if (ateccLocked()) return "atecc608b already locked";
  if (!g_atecc.configLockStatus) {
    if (!g_atecc.writeConfigSparkFun()) return "atecc608b: writing the configuration failed";
    if (!g_atecc.lockConfig()) return "atecc608b: locking the configuration failed";
  }
  if (!g_atecc.slot0LockStatus) {
    if (!g_atecc.createNewKeyPair(0)) return "atecc608b: generating the key failed";
  }
  if (!g_atecc.dataOTPLockStatus) {
    if (!g_atecc.lockDataAndOTP()) return "atecc608b: locking the data zone failed";
  }
  if (!g_atecc.slot0LockStatus) {
    if (!g_atecc.lockDataSlot0()) return "atecc608b: locking slot 0 failed";
  }
  if (!g_atecc.readConfigZone(false) || !ateccLocked()) return "atecc608b: still not locked after provisioning";
  return nullptr;
}
#else
static bool g_ateccPresent = false;
static void ateccBegin() {}
static const char *ateccInfo(uint8_t *, uint8_t *) { return "unsupported"; }
static const char *ateccSign(const uint8_t *, uint8_t *) { return "unsupported"; }
static const char *ateccProvision() { return "unsupported"; }
#endif
