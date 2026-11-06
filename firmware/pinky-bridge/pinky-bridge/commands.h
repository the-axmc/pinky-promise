// Every bridge command: one function per role, plus the line handler that frames the answers.
// Kept in a header (not in the .ino) so the build never depends on generated prototypes.
#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Wire.h>

#include "config.h"
#include "util.h"
#include "wallet.h"
#include "parts.h"
#include "secure_element.h"
#include "camera.h"
#include "nfc.h"
#include "ble_link.h"

// Returned by a command that has already written its own response line.
static const char RESPONSE_SENT_MARK = 0;
static const char *const RESPONSE_SENT = &RESPONSE_SENT_MARK;

static const char *runInfo(JsonDocument &response) {
  response["fw"] = PINKY_FW_VERSION;
  response["role"] = PINKY_ROLE;
  response["board"] = PINKY_BOARD;
  JsonObject has = response["has"].to<JsonObject>();
  has["sht31"] = g_sht31Present;
  has["atecc608b"] = g_ateccPresent;
  has["gps"] = gpsPresent();
  has["camera"] = g_cameraReady;
  has["pn532"] = g_nfcPresent;
  has["enclosure"] = (bool)(PINKY_HAS_ENCLOSURE && !PINKY_IS_ANCHOR && PIN_ENCLOSURE >= 0);
  has["wallet"] = g_walletReady;
  has["anchor"] = (bool)(PINKY_IS_ANCHOR || PINKY_HAS_BLE);
  return nullptr;
}

#if PINKY_IS_ANCHOR

static const char *runAnchorCommand(const char *command, JsonDocument &request, JsonDocument &response) {
  if (strcmp(command, "anchor.info") == 0) {
    if (g_venueId.length() == 0) return "anchor has no venue configured";
    response["venue_id"] = g_venueId;
    response["pubkey"] = bytesToHex(g_walletPub, 64);
    return nullptr;
  }
  if (strcmp(command, "anchor.configure") == 0) {
    const char *venueId = request["venue_id"] | "";
    if (!anchorConfigure(venueId)) return "bad venue_id";
    response["venue_id"] = g_venueId;
    return nullptr;
  }
  if (strcmp(command, "anchor.attest") == 0) {
    uint8_t device[20];
    uint8_t blockhash[32];
    if (!hexToBytes(request["device"] | "", device, 20) || !hexToBytes(request["blockhash"] | "", blockhash, 32)) return "bad hex";
    uint8_t payload[96];
    uint8_t signature[64];
    const char *error = anchorAttest(device, blockhash, payload, signature);
    if (error != nullptr) return error;
    response["payload"] = bytesToHex(payload, 96);
    response["sig"] = bytesToHex(signature, 64);
    response["pubkey"] = bytesToHex(g_walletPub, 64);
    return nullptr;
  }
  return "unsupported";
}

#else

static const char *runDeviceCommand(long id, const char *command, JsonDocument &request, JsonDocument &response) {
  if (strcmp(command, "climate.read") == 0) {
    int32_t tempCenti = 0;
    uint32_t rhCenti = 0;
    const char *error = sht31Read(tempCenti, rhCenti);
    if (error != nullptr) return error;
    response["temp_centi"] = tempCenti;
    response["rh_centi"] = rhCenti;
    return nullptr;
  }

  if (strcmp(command, "gps.read") == 0) {
#if PINKY_HAS_GPS
    if (!g_gpsWired) return "unsupported";
    gpsPoll();
    bool fix = g_gps.location.isValid();
    response["fix"] = fix;
    if (fix) {
      response["age_ms"] = g_gps.location.age();
      response["lat_e7"] = gpsE7(g_gps.location.rawLat());
      response["lon_e7"] = gpsE7(g_gps.location.rawLng());
    }
    response["sats"] = g_gps.satellites.isValid() ? g_gps.satellites.value() : 0;
    response["chars"] = g_gps.charsProcessed(); // 0 means nothing is arriving: check RX/TX
    return nullptr;
#else
    return "unsupported";
#endif
  }

  if (strcmp(command, "se.info") == 0) {
    uint8_t serial[9];
    uint8_t publicKey[64];
    const char *error = ateccInfo(serial, publicKey);
    if (error != nullptr) return error;
    response["serial"] = bytesToHex(serial, 9);
    response["pubkey"] = bytesToHex(publicKey, 64);
    response["locked"] = true;
    return nullptr;
  }

  if (strcmp(command, "se.sign") == 0) {
    uint8_t digest[32];
    uint8_t signature[64];
    if (!hexToBytes(request["digest"] | "", digest, 32)) return "bad hex";
    const char *error = ateccSign(digest, signature);
    if (error != nullptr) return error;
    response["sig"] = bytesToHex(signature, 64);
    return nullptr;
  }

  if (strcmp(command, "se.provision") == 0) {
    const char *confirm = request["confirm"] | "";
    if (strcmp(confirm, "LOCK-FOREVER") != 0) return "confirm must be LOCK-FOREVER";
    const char *error = ateccProvision();
    if (error != nullptr) return error;
    uint8_t serial[9];
    uint8_t publicKey[64];
    error = ateccInfo(serial, publicKey);
    if (error != nullptr) return error;
    response["serial"] = bytesToHex(serial, 9);
    response["pubkey"] = bytesToHex(publicKey, 64);
    response["locked"] = true;
    return nullptr;
  }

  if (strcmp(command, "wallet.info") == 0) {
    if (!g_walletReady) return "wallet key missing";
    response["pubkey"] = bytesToHex(g_walletPub, 64);
    return nullptr;
  }

  if (strcmp(command, "wallet.sign") == 0) {
    uint8_t digest[32];
    uint8_t signature[64];
    if (!hexToBytes(request["digest"] | "", digest, 32)) return "bad hex";
    if (!walletSign(digest, signature)) return "wallet signing failed";
    response["sig"] = bytesToHex(signature, 64);
    return nullptr;
  }

  if (strcmp(command, "camera.capture") == 0) {
    const char *error = cameraCaptureTo(Serial, id);
    return error != nullptr ? error : RESPONSE_SENT;
  }

  if (strcmp(command, "nfc.read") == 0) {
    uint8_t uid[10];
    uint8_t uidLength = 0;
    long timeoutMs = request["timeout_ms"] | 1000L;
    if (timeoutMs < 1) timeoutMs = 1;
    if (timeoutMs > 10000) timeoutMs = 10000;
    const char *error = nfcRead((uint16_t)timeoutMs, uid, uidLength);
    if (error != nullptr) return error;
    response["present"] = uidLength > 0;
    if (uidLength > 0) {
      response["uid"] = bytesToHex(uid, uidLength);
      response["type"] = "iso14443a";
      response["tamper"] = "unknown";
    }
    return nullptr;
  }

  if (strcmp(command, "enclosure.read") == 0) {
#if PINKY_HAS_ENCLOSURE
    if (PIN_ENCLOSURE < 0) return "unsupported";
    enclosurePoll();
    response["closed"] = g_enclosureClosed;
    response["open_count"] = g_enclosureOpens;
    return nullptr;
#else
    return "unsupported";
#endif
  }

  if (strcmp(command, "anchor.attest") == 0) {
#if PINKY_HAS_BLE
    uint8_t device[20];
    uint8_t blockhash[32];
    if (!hexToBytes(request["device"] | "", device, 20) || !hexToBytes(request["blockhash"] | "", blockhash, 32)) return "bad hex";
    uint8_t answer[PINKY_BLE_RESPONSE_SIZE];
    int rssi = 0;
    const char *error = bleAnchorAttest(device, blockhash, answer, rssi);
    if (error != nullptr) return error;
    response["payload"] = bytesToHex(answer, 96);
    response["sig"] = bytesToHex(answer + 96, 64);
    response["pubkey"] = bytesToHex(answer + 160, 64);
    response["rssi"] = rssi;
    return nullptr;
#else
    return "unsupported";
#endif
  }

  return "unsupported";
}

#endif // PINKY_IS_ANCHOR

static const char *run(long id, const char *command, JsonDocument &request, JsonDocument &response) {
  if (strcmp(command, "info") == 0) return runInfo(response);
  if (strcmp(command, "display.show") == 0) {
    lightShow(request["state"] | "IDLE");
    return nullptr;
  }
#if PINKY_IS_ANCHOR
  (void)id;
  return runAnchorCommand(command, request, response);
#else
  return runDeviceCommand(id, command, request, response);
#endif
}

static void handleLine(const char *text) {
  JsonDocument request;
  DeserializationError problem = deserializeJson(request, text);
  if (problem) {
    Serial.print("E not json: ");
    Serial.println(problem.c_str());
    return;
  }
  long id = request["id"] | -1L;
  const char *command = request["cmd"] | "";

  JsonDocument response;
  response["id"] = id;
  const char *error = run(id, command, request, response);
  if (error == RESPONSE_SENT) return;
  if (error != nullptr) {
    response.clear();
    response["id"] = id;
    response["ok"] = false;
    response["error"] = error;
  } else {
    response["ok"] = true;
  }
  serializeJson(response, Serial);
  Serial.println();
}
