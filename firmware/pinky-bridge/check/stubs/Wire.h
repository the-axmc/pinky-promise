#pragma once
#include <Arduino.h>
class TwoWire {
 public:
  bool begin(int sda, int scl, uint32_t frequency = 0);
  void beginTransmission(uint8_t address);
  void beginTransmission(int address);
  uint8_t endTransmission(void);
  size_t write(uint8_t);
  uint8_t requestFrom(int address, int size);
  int read(void);
};
extern TwoWire Wire;
