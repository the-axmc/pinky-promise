// Declarations used from the arduino-esp32 BLE library, written from memory. BLE_STRING is
// std::string on core 2.x and String on core 3.x; the check is run with both.
#pragma once
#include <Arduino.h>
#include <string>
#ifdef STUB_BLE_CORE3
typedef String BLE_STRING;
#else
typedef std::string BLE_STRING;
#endif
class BLEUUID { public: BLEUUID(const char *uuid); };
class BLEAdvertisedDevice {
 public:
  bool haveServiceUUID();
  bool isAdvertisingService(BLEUUID uuid);
  int getRSSI();
};
class BLEAdvertisedDeviceCallbacks { public: virtual ~BLEAdvertisedDeviceCallbacks() {} virtual void onResult(BLEAdvertisedDevice advertisedDevice) = 0; };
class BLEScanResults {};
class BLEScan {
 public:
  void setAdvertisedDeviceCallbacks(BLEAdvertisedDeviceCallbacks *callbacks, bool wantDuplicates = false, bool shouldParse = true);
  void setActiveScan(bool active);
  void setInterval(uint16_t ms);
  void setWindow(uint16_t ms);
#ifdef STUB_BLE_CORE3
  BLEScanResults *start(uint32_t duration, bool is_continue = false);
#else
  BLEScanResults start(uint32_t duration, bool is_continue = false);
#endif
  void stop();
  void clearResults();
};
class BLERemoteCharacteristic {
 public:
  BLE_STRING readValue();
  void writeValue(uint8_t *data, size_t length, bool response = false);
};
class BLERemoteService {
 public:
  BLERemoteCharacteristic *getCharacteristic(const char *uuid);
  BLERemoteCharacteristic *getCharacteristic(BLEUUID uuid);
};
class BLEClient {
 public:
  bool connect(BLEAdvertisedDevice *device);
  void disconnect();
  BLERemoteService *getService(const char *uuid);
  BLERemoteService *getService(BLEUUID uuid);
  int getRssi();
};
class BLECharacteristic;
class BLECharacteristicCallbacks {
 public:
  virtual ~BLECharacteristicCallbacks() {}
  virtual void onRead(BLECharacteristic *) {}
  virtual void onWrite(BLECharacteristic *) {}
};
class BLECharacteristic {
 public:
  static const uint32_t PROPERTY_READ = 1 << 0;
  static const uint32_t PROPERTY_WRITE = 1 << 1;
  void setCallbacks(BLECharacteristicCallbacks *callbacks);
  void setValue(uint8_t *data, size_t size);
  uint8_t *getData();
  size_t getLength();
  BLE_STRING getValue();
};
class BLEService {
 public:
  BLECharacteristic *createCharacteristic(const char *uuid, uint32_t properties);
  void start();
};
class BLEServer;
class BLEServerCallbacks { public: virtual ~BLEServerCallbacks() {} virtual void onConnect(BLEServer *) {} virtual void onDisconnect(BLEServer *) {} };
class BLEServer {
 public:
  BLEService *createService(const char *uuid);
  void setCallbacks(BLEServerCallbacks *callbacks);
};
class BLEAdvertising { public: void addServiceUUID(const char *uuid); void setScanResponse(bool); };
class BLEDevice {
 public:
  static void init(BLE_STRING deviceName);
  static int setMTU(uint16_t mtu);
  static BLEServer *createServer();
  static BLEClient *createClient();
  static BLEScan *getScan();
  static BLEAdvertising *getAdvertising();
  static void startAdvertising();
};
