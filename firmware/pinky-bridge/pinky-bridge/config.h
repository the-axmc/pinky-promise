// pinky-bridge configuration: role, board, pins, and which parts to build in.
//
// PlatformIO sets everything here from platformio.ini (-D flags). With the Arduino IDE there
// are no build flags, so uncomment what you need in the next block instead.
#pragma once

// ---- Arduino IDE users: choose here ------------------------------------------------------
// #define PINKY_BOARD_XIAO_S3_SENSE   // Seeed XIAO ESP32S3 Sense (has the camera)
// #define PINKY_BOARD_S3_DEVKITC      // ESP32-S3-DevKitC-1 or any plain ESP32-S3 board
// #define PINKY_BOARD_S3_EYE          // ESP32-S3-EYE (camera only, see docs/hardware.md)
// #define PINKY_ROLE_ANCHOR           // build the venue anchor instead of the device
// -------------------------------------------------------------------------------------------

#define PINKY_FW_VERSION "0.1.0"

#if defined(PINKY_ROLE_ANCHOR)
#define PINKY_IS_ANCHOR 1
#define PINKY_ROLE "anchor"
#else
#define PINKY_IS_ANCHOR 0
#define PINKY_ROLE "device"
#endif

#if !defined(PINKY_BOARD_XIAO_S3_SENSE) && !defined(PINKY_BOARD_S3_EYE) && !defined(PINKY_BOARD_S3_DEVKITC)
#define PINKY_BOARD_S3_DEVKITC
#endif

// ---- pins ----------------------------------------------------------------------------------
// Every pin can be overridden with a -D flag. -1 means "not connected".

#if defined(PINKY_BOARD_XIAO_S3_SENSE)
// Header pins D0..D10. The camera uses internal pins and none of these.
#define PINKY_BOARD "xiao-esp32s3-sense"
#ifndef PIN_I2C_SDA
#define PIN_I2C_SDA 5 // D4  -> SDA of SHT31, ATECC608B, PN532
#endif
#ifndef PIN_I2C_SCL
#define PIN_I2C_SCL 6 // D5  -> SCL of SHT31, ATECC608B, PN532
#endif
#ifndef PIN_GPS_RX
#define PIN_GPS_RX 44 // D7  <- TX of the GPS module
#endif
#ifndef PIN_GPS_TX
#define PIN_GPS_TX 43 // D6  -> RX of the GPS module
#endif
#ifndef PIN_ENCLOSURE
#define PIN_ENCLOSURE 1 // D0  -> switch to GND, closed while the case is shut
#endif
#ifndef PIN_PN532_IRQ
#define PIN_PN532_IRQ 2 // D1
#endif
#ifndef PIN_PN532_RST
#define PIN_PN532_RST 4 // D3
#endif
#ifndef PIN_LED
#define PIN_LED 21 // the orange user LED
#endif
#ifndef PIN_LED_ACTIVE_LOW
#define PIN_LED_ACTIVE_LOW 1
#endif
#ifndef PIN_LED_GREEN
#define PIN_LED_GREEN -1 // optional external LEDs: D8 (7), D9 (8), D10 (9) are free
#endif
#ifndef PIN_LED_AMBER
#define PIN_LED_AMBER -1
#endif
#ifndef PIN_LED_RED
#define PIN_LED_RED -1
#endif
#define PINKY_CAMERA_PINS 1
#define CAM_PIN_PWDN -1
#define CAM_PIN_RESET -1
#define CAM_PIN_XCLK 10
#define CAM_PIN_SIOD 40
#define CAM_PIN_SIOC 39
#define CAM_PIN_D7 48
#define CAM_PIN_D6 11
#define CAM_PIN_D5 12
#define CAM_PIN_D4 14
#define CAM_PIN_D3 16
#define CAM_PIN_D2 18
#define CAM_PIN_D1 17
#define CAM_PIN_D0 15
#define CAM_PIN_VSYNC 38
#define CAM_PIN_HREF 47
#define CAM_PIN_PCLK 13

#elif defined(PINKY_BOARD_S3_EYE)
// The camera works with these pins. The board has no general pin header, so sensor pins are
// left unconnected here: check them against the board's schematic before wiring anything.
#define PINKY_BOARD "esp32-s3-eye"
#ifndef PIN_I2C_SDA
#define PIN_I2C_SDA -1
#endif
#ifndef PIN_I2C_SCL
#define PIN_I2C_SCL -1
#endif
#ifndef PIN_GPS_RX
#define PIN_GPS_RX -1
#endif
#ifndef PIN_GPS_TX
#define PIN_GPS_TX -1
#endif
#ifndef PIN_ENCLOSURE
#define PIN_ENCLOSURE -1
#endif
#ifndef PIN_PN532_IRQ
#define PIN_PN532_IRQ -1
#endif
#ifndef PIN_PN532_RST
#define PIN_PN532_RST -1
#endif
#ifndef PIN_LED
#define PIN_LED -1
#endif
#ifndef PIN_LED_ACTIVE_LOW
#define PIN_LED_ACTIVE_LOW 0
#endif
#ifndef PIN_LED_GREEN
#define PIN_LED_GREEN -1
#endif
#ifndef PIN_LED_AMBER
#define PIN_LED_AMBER -1
#endif
#ifndef PIN_LED_RED
#define PIN_LED_RED -1
#endif
#define PINKY_CAMERA_PINS 1
#define CAM_PIN_PWDN -1
#define CAM_PIN_RESET -1
#define CAM_PIN_XCLK 15
#define CAM_PIN_SIOD 4
#define CAM_PIN_SIOC 5
#define CAM_PIN_D7 16
#define CAM_PIN_D6 17
#define CAM_PIN_D5 18
#define CAM_PIN_D4 12
#define CAM_PIN_D3 10
#define CAM_PIN_D2 8
#define CAM_PIN_D1 9
#define CAM_PIN_D0 11
#define CAM_PIN_VSYNC 6
#define CAM_PIN_HREF 7
#define CAM_PIN_PCLK 13

#else // PINKY_BOARD_S3_DEVKITC: no camera; take seal photos with a phone (see docs/hardware.md)
#define PINKY_BOARD "esp32-s3-devkitc"
#ifndef PIN_I2C_SDA
#define PIN_I2C_SDA 8
#endif
#ifndef PIN_I2C_SCL
#define PIN_I2C_SCL 9
#endif
#ifndef PIN_GPS_RX
#define PIN_GPS_RX 18 // <- TX of the GPS module
#endif
#ifndef PIN_GPS_TX
#define PIN_GPS_TX 17 // -> RX of the GPS module
#endif
#ifndef PIN_ENCLOSURE
#define PIN_ENCLOSURE 4
#endif
#ifndef PIN_PN532_IRQ
#define PIN_PN532_IRQ 5
#endif
#ifndef PIN_PN532_RST
#define PIN_PN532_RST 6
#endif
#ifndef PIN_LED
#define PIN_LED -1
#endif
#ifndef PIN_LED_ACTIVE_LOW
#define PIN_LED_ACTIVE_LOW 0
#endif
#ifndef PIN_LED_GREEN
#define PIN_LED_GREEN 10
#endif
#ifndef PIN_LED_AMBER
#define PIN_LED_AMBER 11
#endif
#ifndef PIN_LED_RED
#define PIN_LED_RED 12
#endif
#define PINKY_CAMERA_PINS 0
#endif

// The addressable RGB LED of a DevKitC (GPIO 48 on v1.0 boards, 38 on v1.1). -1 = not used.
#ifndef PIN_LED_RGB
#define PIN_LED_RGB -1
#endif

// ---- parts ---------------------------------------------------------------------------------
// 1 builds support for the part in. The firmware still checks at boot whether the part answers
// and reports it in `info`, so leaving these on with nothing wired is harmless — except the
// enclosure switch, which cannot be detected: turn it on only once the switch is wired, or
// every checkpoint will report an open case.

#ifndef PINKY_HAS_SHT31
#define PINKY_HAS_SHT31 1
#endif
#ifndef PINKY_HAS_ATECC
#define PINKY_HAS_ATECC 1
#endif
#ifndef PINKY_HAS_GPS
#define PINKY_HAS_GPS 1
#endif
#ifndef PINKY_HAS_PN532
#define PINKY_HAS_PN532 1
#endif
#ifndef PINKY_HAS_CAMERA
#define PINKY_HAS_CAMERA PINKY_CAMERA_PINS
#endif
#ifndef PINKY_HAS_ENCLOSURE
#define PINKY_HAS_ENCLOSURE 0
#endif
// BLE link between device and anchor. Off by default: with it off, the anchor board is plugged
// into the gateway's second USB port instead. Turn it on for BOTH boards.
#ifndef PINKY_HAS_BLE
#define PINKY_HAS_BLE 0
#endif

// ---- details -------------------------------------------------------------------------------
#ifndef SHT31_ADDRESS
#define SHT31_ADDRESS 0x44 // 0x45 when the ADDR pin is pulled high
#endif
#ifndef ATECC_ADDRESS
#define ATECC_ADDRESS 0x60
#endif
#ifndef PN532_ADDRESS
#define PN532_ADDRESS 0x24
#endif
#ifndef GPS_BAUD
#define GPS_BAUD 9600 // NEO-6M and NEO-M8N default; some M8N boards ship at 38400
#endif
#ifndef PINKY_BLE_SCAN_SECONDS
#define PINKY_BLE_SCAN_SECONDS 4
#endif
