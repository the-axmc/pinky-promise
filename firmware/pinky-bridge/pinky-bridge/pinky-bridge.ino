// pinky-bridge — turns an ESP32-S3 into the hardware half of a Pinky Promise device (or venue
// anchor). The host (packages/device) is the brain; this firmware exposes each part on the
// board as one command over USB serial, so parts can be wired up and tested one at a time.
//
// Protocol: JSON Lines at 115200 baud, host initiates, one response per request, matched by id.
//
//   -> {"id":7,"cmd":"climate.read"}
//   <- {"id":7,"ok":true,"temp_centi":425,"rh_centi":4550}
//   <- {"id":8,"ok":false,"error":"sht31 crc"}
//
// Lines that do not start with "{" are logs. Binary values are lowercase hex with no prefix.
// The command set and its types are in packages/device/src/bridge/protocol.ts, and
// packages/device/src/bridge/mock-board.ts is a working reference of every answer.
//
// STATUS: written against the libraries' published headers but NOT yet compiled or run on a
// board. Expect to fix small things on first build. See docs/hardware.md.

#include <Arduino.h>
#include <Wire.h>

#include "commands.h"

static char g_line[1024];
static size_t g_lineLength = 0;
static bool g_lineTooLong = false;

void setup() {
  Serial.begin(115200);
  delay(200);
  lightBegin();
  if (PIN_I2C_SDA >= 0 && PIN_I2C_SCL >= 0) Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

  walletBegin();
#if PINKY_IS_ANCHOR
  anchorBegin();
#else
  sht31Begin();
  ateccBegin();
  nfcBegin();
  cameraBegin();
  enclosureBegin();
  gpsBegin();
#endif
  bleBegin();

  Serial.println();
  Serial.print("pinky-bridge ");
  Serial.print(PINKY_FW_VERSION);
  Serial.print(" ");
  Serial.print(PINKY_ROLE);
  Serial.println(" ready");
}

void loop() {
  gpsPoll();
  enclosurePoll();
  blePoll();
  lightTick();

  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n') {
      if (g_lineTooLong) {
        Serial.println("E line too long");
      } else if (g_lineLength > 0) {
        g_line[g_lineLength] = 0;
        handleLine(g_line);
      }
      g_lineLength = 0;
      g_lineTooLong = false;
    } else if (c != '\r') {
      if (g_lineLength < sizeof(g_line) - 1) g_line[g_lineLength++] = c;
      else g_lineTooLong = true;
    }
  }
}
