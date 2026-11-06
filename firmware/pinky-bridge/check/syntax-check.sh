#!/bin/sh
# A syntax and type check of the firmware with the host's C++ compiler — for machines without
# the ESP32 toolchain. It is NOT a build: the Arduino core, the BLE library, the camera driver
# and mbedTLS are replaced by the declaration-only stubs in ./stubs (the ATECC608B, PN532 and
# TinyGPS++ stubs mirror those libraries' published headers; the rest are written from memory).
# ArduinoJson and micro-ecc are header-only and are checked against the real thing, which this
# script downloads into ./.deps on first use.
#
#   sh firmware/pinky-bridge/check/syntax-check.sh [-v]
#
# The real test is `pio run` (see ../platformio.ini) and a board on the desk.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SKETCH="$HERE/../pinky-bridge"
VERBOSE="${1:-}"
CXX="${CXX:-c++}"

mkdir -p "$HERE/.deps/arduinojson" "$HERE/.deps/uecc"
[ -s "$HERE/.deps/arduinojson/ArduinoJson.h" ] || curl -fsSL --max-time 60 -o "$HERE/.deps/arduinojson/ArduinoJson.h" \
  https://github.com/bblanchon/ArduinoJson/releases/download/v7.4.2/ArduinoJson-v7.4.2.h || { echo "could not download ArduinoJson"; exit 2; }
[ -s "$HERE/.deps/uecc/uECC.h" ] || curl -fsSL --max-time 60 -o "$HERE/.deps/uecc/uECC.h" \
  https://raw.githubusercontent.com/kmackay/micro-ecc/master/uECC.h || { echo "could not download micro-ecc"; exit 2; }

fails=0
check() {
  name="$1"; shift
  out=$("$CXX" -fsyntax-only -x c++ -std=gnu++17 -Wall -Wextra -Wno-unused-function -Wno-unused-variable -Wno-unused-parameter \
    -DARDUINO=10819 -DESP32 -DARDUINOJSON_ENABLE_PROGMEM=0 \
    -I "$HERE/stubs" -I "$HERE/.deps/arduinojson" -I "$HERE/.deps/uecc" -I "$SKETCH" "$@" "$SKETCH/pinky-bridge.ino" 2>&1)
  if [ -z "$out" ]; then
    echo "ok    $name"
  else
    echo "FAIL  $name"; fails=$((fails + 1))
    [ -n "$VERBOSE" ] && echo "$out" | grep -E "error|warning" | head -12
  fi
}

check "device  xiao-s3-sense"             -DPINKY_BOARD_XIAO_S3_SENSE
check "device  xiao + enclosure + ble"    -DPINKY_BOARD_XIAO_S3_SENSE -DPINKY_HAS_ENCLOSURE=1 -DPINKY_HAS_BLE=1
check "device  xiao + ble (core 3 types)" -DPINKY_BOARD_XIAO_S3_SENSE -DPINKY_HAS_BLE=1 -DSTUB_BLE_CORE3
check "device  s3-devkitc"                -DPINKY_BOARD_S3_DEVKITC
check "device  s3-devkitc + rgb led"      -DPINKY_BOARD_S3_DEVKITC -DPIN_LED_RGB=48 -DPINKY_HAS_ENCLOSURE=1
check "device  s3-eye"                    -DPINKY_BOARD_S3_EYE
check "device  every optional part off"   -DPINKY_BOARD_S3_DEVKITC -DPINKY_HAS_SHT31=0 -DPINKY_HAS_ATECC=0 -DPINKY_HAS_GPS=0 -DPINKY_HAS_PN532=0
check "device  default board"
check "anchor  xiao"                      -DPINKY_BOARD_XIAO_S3_SENSE -DPINKY_ROLE_ANCHOR
check "anchor  s3-devkitc + ble"          -DPINKY_BOARD_S3_DEVKITC -DPINKY_ROLE_ANCHOR -DPINKY_HAS_BLE=1
check "anchor  s3-devkitc + ble (core 3)" -DPINKY_BOARD_S3_DEVKITC -DPINKY_ROLE_ANCHOR -DPINKY_HAS_BLE=1 -DSTUB_BLE_CORE3
echo "$fails configuration(s) failed"
[ "$fails" -eq 0 ]
