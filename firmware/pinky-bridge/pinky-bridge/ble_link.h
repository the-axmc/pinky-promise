// The radio link between a device and a venue anchor (optional, PINKY_HAS_BLE).
//
// The anchor advertises one service. A device that is asked for an attestation scans for it,
// connects, writes its request and reads the answer — which it can only do while it is within
// radio range of the anchor. That range is the whole point: it is what makes the co-signature
// evidence of being at the venue.
//
//   request  characteristic (write)  device address (20) || blockhash (32)
//   response characteristic (read)   PPA1 payload (96) || signature r||s (64) || public key (64)
//
// With BLE off, the anchor board is plugged into the gateway's second USB port and the host
// relays instead: the same signature, but it shows the anchor was at the gateway, not that the
// device was near the anchor.
#pragma once

#include <Arduino.h>
#include "config.h"
#include "wallet.h"

#if PINKY_HAS_BLE
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEServer.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>
#include <BLEClient.h>

#define PINKY_BLE_SERVICE "8f2a0001-5b1e-4c7a-9d3f-70696e6b7901"
#define PINKY_BLE_REQUEST "8f2a0002-5b1e-4c7a-9d3f-70696e6b7901"
#define PINKY_BLE_RESPONSE "8f2a0003-5b1e-4c7a-9d3f-70696e6b7901"
#define PINKY_BLE_REQUEST_SIZE 52
#define PINKY_BLE_RESPONSE_SIZE 224

#if PINKY_IS_ANCHOR
// ---- anchor: the peripheral ------------------------------------------------------------------

static BLECharacteristic *g_bleResponse = nullptr;
static volatile bool g_bleRequestPending = false;
static uint8_t g_bleRequest[PINKY_BLE_REQUEST_SIZE];

class PinkyRequestCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    if (characteristic->getLength() != PINKY_BLE_REQUEST_SIZE) return;
    memcpy(g_bleRequest, characteristic->getData(), PINKY_BLE_REQUEST_SIZE);
    g_bleRequestPending = true; // signed on the main loop, not in the radio's callback
  }
};

class PinkyServerCallbacks : public BLEServerCallbacks {
  void onDisconnect(BLEServer *) override { BLEDevice::startAdvertising(); }
};

static void bleClearResponse() {
  uint8_t empty = 0;
  g_bleResponse->setValue(&empty, 1);
}

static void bleBegin() {
  BLEDevice::init("pinky-anchor");
  BLEDevice::setMTU(247);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new PinkyServerCallbacks());
  BLEService *service = server->createService(PINKY_BLE_SERVICE);
  BLECharacteristic *request = service->createCharacteristic(PINKY_BLE_REQUEST, BLECharacteristic::PROPERTY_WRITE);
  request->setCallbacks(new PinkyRequestCallbacks());
  g_bleResponse = service->createCharacteristic(PINKY_BLE_RESPONSE, BLECharacteristic::PROPERTY_READ);
  bleClearResponse();
  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(PINKY_BLE_SERVICE);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
}

static void blePoll() {
  if (!g_bleRequestPending) return;
  g_bleRequestPending = false;
  uint8_t answer[PINKY_BLE_RESPONSE_SIZE];
  if (anchorAttest(g_bleRequest, g_bleRequest + 20, answer, answer + 96) != nullptr) {
    bleClearResponse();
    return;
  }
  memcpy(answer + 160, g_walletPub, 64);
  g_bleResponse->setValue(answer, sizeof(answer));
}

#else
// ---- device: the central -----------------------------------------------------------------------

static BLEAdvertisedDevice *g_bleFound = nullptr;
static BLEClient *g_bleClient = nullptr;

class PinkyScanCallbacks : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice advertised) override {
    if (g_bleFound != nullptr) return;
    if (advertised.haveServiceUUID() && advertised.isAdvertisingService(BLEUUID(PINKY_BLE_SERVICE))) {
      g_bleFound = new BLEAdvertisedDevice(advertised);
      BLEDevice::getScan()->stop();
    }
  }
};

static void bleBegin() {
  BLEDevice::init("pinky-device");
  BLEDevice::setMTU(247);
  BLEScan *scan = BLEDevice::getScan();
  scan->setAdvertisedDeviceCallbacks(new PinkyScanCallbacks());
  scan->setActiveScan(true);
  scan->setInterval(100);
  scan->setWindow(99);
}

static void blePoll() {}

// Asks the anchor in range to co-sign. answer: payload (96) || signature (64) || public key (64).
// Returns nullptr on success; "no anchor in range" when the scan finds none.
static const char *bleAnchorAttest(const uint8_t device[20], const uint8_t blockhash[32], uint8_t answer[PINKY_BLE_RESPONSE_SIZE], int &rssi) {
  if (g_bleFound != nullptr) {
    delete g_bleFound;
    g_bleFound = nullptr;
  }
  BLEScan *scan = BLEDevice::getScan();
  scan->start(PINKY_BLE_SCAN_SECONDS, false);
  scan->clearResults();
  if (g_bleFound == nullptr) return "no anchor in range";
  rssi = g_bleFound->getRSSI();

  if (g_bleClient == nullptr) g_bleClient = BLEDevice::createClient();
  if (!g_bleClient->connect(g_bleFound)) return "anchor refused the connection";

  const char *error = "anchor does not offer the attestation service";
  BLERemoteService *service = g_bleClient->getService(PINKY_BLE_SERVICE);
  BLERemoteCharacteristic *request = service != nullptr ? service->getCharacteristic(PINKY_BLE_REQUEST) : nullptr;
  BLERemoteCharacteristic *response = service != nullptr ? service->getCharacteristic(PINKY_BLE_RESPONSE) : nullptr;
  if (request != nullptr && response != nullptr) {
    uint8_t message[PINKY_BLE_REQUEST_SIZE];
    memcpy(message, device, 20);
    memcpy(message + 20, blockhash, 32);
    request->writeValue(message, sizeof(message), true);
    error = "anchor did not answer";
    for (int attempt = 0; attempt < 15 && error != nullptr; attempt++) {
      delay(200);
      auto value = response->readValue();
      // Bytes 36..87 of the payload are the device and the blockhash: this answer is for us.
      if (value.length() == PINKY_BLE_RESPONSE_SIZE && memcmp(value.c_str() + 36, message, sizeof(message)) == 0) {
        memcpy(answer, value.c_str(), PINKY_BLE_RESPONSE_SIZE);
        error = nullptr;
      }
    }
  }
  g_bleClient->disconnect();
  return error;
}
#endif // PINKY_IS_ANCHOR

#else // !PINKY_HAS_BLE
static void bleBegin() {}
static void blePoll() {}
#endif
