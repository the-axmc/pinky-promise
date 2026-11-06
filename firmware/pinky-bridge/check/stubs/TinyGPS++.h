// Mirrors the public declarations of TinyGPS++ (mikalhart/TinyGPSPlus, src/TinyGPS++.h).
#pragma once
#include <Arduino.h>
struct RawDegrees {
  uint16_t deg;
  uint32_t billionths;
  bool negative;
  RawDegrees() : deg(0), billionths(0), negative(false) {}
};
struct TinyGPSLocation {
  bool isValid() const;
  bool isUpdated() const;
  uint32_t age() const;
  const RawDegrees &rawLat();
  const RawDegrees &rawLng();
  double lat();
  double lng();
};
struct TinyGPSInteger {
  bool isValid() const;
  bool isUpdated() const;
  uint32_t age() const;
  uint32_t value();
};
class TinyGPSPlus {
 public:
  TinyGPSPlus();
  bool encode(char c);
  TinyGPSLocation location;
  TinyGPSInteger satellites;
  uint32_t charsProcessed() const;
  uint32_t sentencesWithFix() const;
  uint32_t failedChecksum() const;
  uint32_t passedChecksum() const;
};
