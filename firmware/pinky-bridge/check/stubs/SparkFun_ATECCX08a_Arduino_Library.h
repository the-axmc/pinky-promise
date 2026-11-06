// Mirrors the public section of class ATECCX08A (sparkfun/SparkFun_ATECCX08a_Arduino_Library).
#pragma once
#include <Arduino.h>
#include <Wire.h>
#define ATECC508A_ADDRESS_DEFAULT 0x60
#define SIGNATURE_SIZE 64
#define PUBLIC_KEY_SIZE 64
#define SERIAL_NUMBER_SIZE 9
class ATECCX08A {
 public:
  bool begin(uint8_t i2caddr = ATECC508A_ADDRESS_DEFAULT, TwoWire &wirePort = Wire, Stream &serialPort = Serial);
  uint8_t serialNumber[SERIAL_NUMBER_SIZE];
  bool configLockStatus;
  bool dataOTPLockStatus;
  bool slot0LockStatus;
  byte publicKey64Bytes[PUBLIC_KEY_SIZE];
  uint8_t signature[SIGNATURE_SIZE];
  bool wakeUp();
  bool writeConfigSparkFun();
  bool lockConfig();
  bool lockDataAndOTP();
  bool lockDataSlot0();
  bool createNewKeyPair(uint16_t slot = 0x0000);
  bool generatePublicKey(uint16_t slot = 0x0000, bool debug = true);
  bool createSignature(uint8_t *data, uint16_t slot = 0x0000);
  bool readConfigZone(bool debug = true);
};
