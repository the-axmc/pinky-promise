// The simple parts: SHT31, GPS, enclosure switch, status light.
#pragma once

#include <Arduino.h>
#include <Wire.h>
#include <Preferences.h>
#include "config.h"
#include "util.h"

static inline bool i2cAnswers(uint8_t address) {
  if (PIN_I2C_SDA < 0 || PIN_I2C_SCL < 0) return false;
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

// ---- SHT31 ----------------------------------------------------------------------------------
// Driven directly over I2C: one single-shot, high-repeatability measurement per request, both
// checksums verified. A failed checksum is an error, never a guessed value.

static bool g_sht31Present = false;

static uint8_t sht31Crc(const uint8_t *data, size_t length) {
  uint8_t crc = 0xFF;
  for (size_t i = 0; i < length; i++) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; bit++) crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
  }
  return crc;
}

static void sht31Begin() {
#if PINKY_HAS_SHT31
  g_sht31Present = i2cAnswers(SHT31_ADDRESS);
#endif
}

// Hundredths of a degree Celsius and hundredths of a percent. Returns nullptr on success.
static const char *sht31Read(int32_t &tempCenti, uint32_t &rhCenti) {
  if (!g_sht31Present) return "unsupported";
  Wire.beginTransmission(SHT31_ADDRESS);
  Wire.write((uint8_t)0x24);
  Wire.write((uint8_t)0x00);
  if (Wire.endTransmission() != 0) return "sht31 not answering";
  delay(20);
  if (Wire.requestFrom((int)SHT31_ADDRESS, 6) != 6) return "sht31 short read";
  uint8_t raw[6];
  for (int i = 0; i < 6; i++) raw[i] = (uint8_t)Wire.read();
  if (sht31Crc(raw, 2) != raw[2] || sht31Crc(raw + 3, 2) != raw[5]) return "sht31 crc";
  uint32_t t = ((uint32_t)raw[0] << 8) | raw[1];
  uint32_t h = ((uint32_t)raw[3] << 8) | raw[4];
  // Datasheet: T = -45 + 175 * raw / 65535, RH = 100 * raw / 65535. Rounded to the nearest.
  tempCenti = (int32_t)((17500UL * t + 32767UL) / 65535UL) - 4500;
  rhCenti = (uint32_t)((10000UL * h + 32767UL) / 65535UL);
  return nullptr;
}

// ---- GPS (NEO-6M / NEO-M8N, NMEA over UART) ----------------------------------------------------

#if PINKY_HAS_GPS && !PINKY_IS_ANCHOR
#include <TinyGPS++.h>
static TinyGPSPlus g_gps;
static HardwareSerial g_gpsSerial(1);
static bool g_gpsWired = false;

static void gpsPoll() {
  if (!g_gpsWired) return;
  while (g_gpsSerial.available() > 0) g_gps.encode((char)g_gpsSerial.read());
}

static void gpsBegin() {
  if (PIN_GPS_RX < 0) return;
  g_gpsSerial.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  g_gpsWired = true;
  // A powered module talks once a second, fix or no fix. Give it time to say something, so
  // `info` can tell a wired module from an empty pin.
  uint32_t start = millis();
  while (millis() - start < 1500 && g_gps.charsProcessed() < 16) {
    gpsPoll();
    delay(5);
  }
}

static bool gpsPresent() { return g_gpsWired && g_gps.charsProcessed() >= 16; }

// Degrees in 1e-7 units, straight from the digits of the NMEA sentence (no floating point).
static int32_t gpsE7(const RawDegrees &raw) {
  int32_t value = (int32_t)raw.deg * 10000000L + (int32_t)(raw.billionths / 100UL);
  return raw.negative ? -value : value;
}
#else
static void gpsPoll() {}
static void gpsBegin() {}
static bool gpsPresent() { return false; }
#endif

// ---- enclosure tamper switch -------------------------------------------------------------------
// A switch between the pin and GND that is closed while the case is shut. Every opening is
// counted and the count is kept in flash, so opening the case with the power off still shows:
// the count is checked again at boot.

static bool g_enclosureClosed = true;
static bool g_enclosureRaw = true;
static uint32_t g_enclosureChangedAt = 0;
static uint32_t g_enclosureOpens = 0;

static void enclosureCountOpening() {
  g_enclosureOpens++;
  Preferences prefs;
  prefs.begin("pinky", false);
  prefs.putUInt("opens", g_enclosureOpens);
  prefs.end();
}

static void enclosureBegin() {
#if PINKY_HAS_ENCLOSURE
  if (PIN_ENCLOSURE < 0) return;
  pinMode(PIN_ENCLOSURE, INPUT_PULLUP);
  Preferences prefs;
  prefs.begin("pinky", false);
  g_enclosureOpens = prefs.getUInt("opens", 0);
  prefs.end();
  g_enclosureClosed = g_enclosureRaw = digitalRead(PIN_ENCLOSURE) == LOW;
  if (!g_enclosureClosed) enclosureCountOpening();
#endif
}

static void enclosurePoll() {
#if PINKY_HAS_ENCLOSURE
  if (PIN_ENCLOSURE < 0) return;
  bool closedNow = digitalRead(PIN_ENCLOSURE) == LOW;
  if (closedNow != g_enclosureRaw) {
    g_enclosureRaw = closedNow;
    g_enclosureChangedAt = millis();
  }
  if (closedNow != g_enclosureClosed && millis() - g_enclosureChangedAt > 50) {
    g_enclosureClosed = closedNow;
    if (!closedNow) enclosureCountOpening();
  }
#endif
}

// ---- status light ------------------------------------------------------------------------------
// PENDING must look like "not accepted": amber, blinking slowly. With a single LED the states
// differ by rhythm instead of colour: slow blink = pending, steady = accepted, fast = refused or
// frozen, medium = escalated.

enum PinkyLight { LIGHT_OFF, LIGHT_GREEN, LIGHT_AMBER, LIGHT_RED };
static PinkyLight g_light = LIGHT_OFF;
static uint16_t g_lightPeriod = 0; // full blink period in ms; 0 = steady
static uint32_t g_lightUntil = 0;  // for the short "reading" blip; 0 = no limit

static void lightPin(int pin, bool on, bool activeLow) {
  if (pin < 0) return;
  digitalWrite(pin, (on != activeLow) ? HIGH : LOW);
}

static void lightWrite(PinkyLight colour, bool on) {
  lightPin(PIN_LED, on && colour != LIGHT_OFF, PIN_LED_ACTIVE_LOW);
  lightPin(PIN_LED_GREEN, on && colour == LIGHT_GREEN, false);
  lightPin(PIN_LED_AMBER, on && colour == LIGHT_AMBER, false);
  lightPin(PIN_LED_RED, on && colour == LIGHT_RED, false);
#if PIN_LED_RGB >= 0
  uint8_t level = on ? 40 : 0;
  neopixelWrite(PIN_LED_RGB, (colour == LIGHT_RED || colour == LIGHT_AMBER) ? level : 0,
                (colour == LIGHT_GREEN || colour == LIGHT_AMBER) ? level / (colour == LIGHT_AMBER ? 2 : 1) : 0, 0);
#endif
}

static void lightBegin() {
  const int pins[] = {PIN_LED, PIN_LED_GREEN, PIN_LED_AMBER, PIN_LED_RED};
  for (int pin : pins) {
    if (pin >= 0) pinMode(pin, OUTPUT);
  }
  lightWrite(LIGHT_OFF, false);
}

static void lightShow(const char *state) {
  g_lightUntil = 0;
  if (strcmp(state, "PENDING") == 0) {
    g_light = LIGHT_AMBER;
    g_lightPeriod = 1000;
  } else if (strcmp(state, "ACCEPTED") == 0) {
    g_light = LIGHT_GREEN;
    g_lightPeriod = 0;
  } else if (strcmp(state, "ESCALATED") == 0) {
    g_light = LIGHT_AMBER;
    g_lightPeriod = 400;
  } else if (strcmp(state, "REFUSED") == 0 || strcmp(state, "FROZEN") == 0 || strcmp(state, "BLOCKED_BY_BREACH") == 0) {
    g_light = LIGHT_RED;
    g_lightPeriod = 200;
  } else if (strcmp(state, "READING") == 0) {
    g_light = LIGHT_GREEN;
    g_lightPeriod = 0;
    g_lightUntil = millis() + 150;
  } else {
    g_light = LIGHT_OFF;
    g_lightPeriod = 0;
  }
}

static void lightTick() {
  if (g_lightUntil != 0 && (int32_t)(millis() - g_lightUntil) >= 0) {
    g_light = LIGHT_OFF;
    g_lightUntil = 0;
  }
  bool on = g_lightPeriod == 0 || (millis() % g_lightPeriod) < (uint32_t)(g_lightPeriod / 2);
  lightWrite(g_light, on);
}
