// Small helpers shared by every part: bare hex, SHA-256, and a sink for library chatter.
#pragma once

#include <Arduino.h>
#include "mbedtls/sha256.h"

static inline int hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// Parses exactly `length` bytes of hex without a prefix. False on anything else.
static inline bool hexToBytes(const char *hex, uint8_t *out, size_t length) {
  if (hex == nullptr || strlen(hex) != length * 2) return false;
  for (size_t i = 0; i < length; i++) {
    int hi = hexNibble(hex[2 * i]);
    int lo = hexNibble(hex[2 * i + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  return true;
}

static inline String bytesToHex(const uint8_t *data, size_t length) {
  static const char digits[] = "0123456789abcdef";
  String out;
  out.reserve(length * 2);
  for (size_t i = 0; i < length; i++) {
    out += digits[data[i] >> 4];
    out += digits[data[i] & 0x0f];
  }
  return out;
}

static inline void sha256Of(const uint8_t *data, size_t length, uint8_t out[32]) {
  mbedtls_sha256(data, length, out, 0);
}

// Libraries that print debug text get this instead of Serial, so nothing they say can land in
// the middle of a response line.
class NullStream : public Stream {
 public:
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
  size_t write(uint8_t) override { return 1; }
};
