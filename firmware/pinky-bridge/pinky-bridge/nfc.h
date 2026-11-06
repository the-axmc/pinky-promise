// PN532 NFC reader on I2C: reads the UID of the seal tag in its field.
//
// The tamper loop of an NTAG 213 TT / NTAG 424 DNA TagTamper is NOT read yet: `tamper` is
// reported as "unknown" for every tag. What is detected today is the tag being present, being
// the same tag (UID), or being gone.
#pragma once

#include <Arduino.h>
#include <Wire.h>
#include "config.h"

#if PINKY_HAS_PN532 && !PINKY_IS_ANCHOR
#include <Adafruit_PN532.h>

static Adafruit_PN532 g_nfc(PIN_PN532_IRQ, PIN_PN532_RST, &Wire);
static bool g_nfcPresent = false;

static void nfcBegin() {
  if (PIN_I2C_SDA < 0) return;
  // Only talk to the library when something answers at the PN532's address: its start-up waits
  // on a chip that is not there.
  Wire.beginTransmission((uint8_t)PN532_ADDRESS);
  if (Wire.endTransmission() != 0) return;
  g_nfc.begin();
  if (g_nfc.getFirmwareVersion() == 0) return;
  g_nfc.SAMConfig();
  g_nfcPresent = true;
}

// Waits up to timeoutMs for a tag. uidLength is 0 when none came into the field.
static const char *nfcRead(uint16_t timeoutMs, uint8_t uid[10], uint8_t &uidLength) {
  if (!g_nfcPresent) return "unsupported";
  uidLength = 0;
  uint8_t length = 0;
  if (g_nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &length, timeoutMs == 0 ? 1 : timeoutMs)) {
    uidLength = length > 10 ? 10 : length;
  }
  return nullptr;
}
#else
static bool g_nfcPresent = false;
static void nfcBegin() {}
static const char *nfcRead(uint16_t, uint8_t *, uint8_t &uidLength) {
  uidLength = 0;
  return "unsupported";
}
#endif
