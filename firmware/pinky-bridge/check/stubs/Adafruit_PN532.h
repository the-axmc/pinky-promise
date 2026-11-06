// Mirrors the declarations used from adafruit/Adafruit-PN532 (Adafruit_PN532.h).
#pragma once
#include <Arduino.h>
#include <Wire.h>
#define PN532_MIFARE_ISO14443A (0x00)
#define PN532_I2C_ADDRESS (0x48 >> 1)
class Adafruit_PN532 {
 public:
  Adafruit_PN532(uint8_t irq, uint8_t reset, TwoWire *theWire = &Wire);
  bool begin(void);
  uint32_t getFirmwareVersion(void);
  bool SAMConfig(void);
  bool readPassiveTargetID(uint8_t cardbaudrate, uint8_t *uid, uint8_t *uidLength, uint16_t timeout = 0);
  uint8_t ntag2xx_ReadPage(uint8_t page, uint8_t *buffer);
};
