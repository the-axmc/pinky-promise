// The camera: one JPEG frame per request, sent as base64 inside the response line.
#pragma once

#include <Arduino.h>
#include "config.h"

#if PINKY_HAS_CAMERA && PINKY_CAMERA_PINS && !PINKY_IS_ANCHOR
#include "esp_camera.h"
#include "mbedtls/base64.h"

static bool g_cameraReady = false;

static void cameraBegin() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = CAM_PIN_D0;
  config.pin_d1 = CAM_PIN_D1;
  config.pin_d2 = CAM_PIN_D2;
  config.pin_d3 = CAM_PIN_D3;
  config.pin_d4 = CAM_PIN_D4;
  config.pin_d5 = CAM_PIN_D5;
  config.pin_d6 = CAM_PIN_D6;
  config.pin_d7 = CAM_PIN_D7;
  config.pin_xclk = CAM_PIN_XCLK;
  config.pin_pclk = CAM_PIN_PCLK;
  config.pin_vsync = CAM_PIN_VSYNC;
  config.pin_href = CAM_PIN_HREF;
  config.pin_sccb_sda = CAM_PIN_SIOD;
  config.pin_sccb_scl = CAM_PIN_SIOC;
  config.pin_pwdn = CAM_PIN_PWDN;
  config.pin_reset = CAM_PIN_RESET;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.jpeg_quality = 12;
  config.fb_count = 1;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA; // 640 x 480: enough to judge a seal, ~20-40 kB
    config.fb_location = CAMERA_FB_IN_PSRAM;
  } else {
    config.frame_size = FRAMESIZE_QVGA;
    config.fb_location = CAMERA_FB_IN_DRAM;
  }
  g_cameraReady = esp_camera_init(&config) == ESP_OK;
}

// Writes the whole response line itself, because a frame does not fit in a JSON document in
// RAM. Returns nullptr once the line is out, or what went wrong (nothing was written then).
static const char *cameraCaptureTo(Stream &out, long id) {
  if (!g_cameraReady) return "unsupported";
  // The driver keeps one frame in its buffer; drop it so the picture is of now, not of earlier.
  camera_fb_t *frame = esp_camera_fb_get();
  if (frame != nullptr) esp_camera_fb_return(frame);
  frame = esp_camera_fb_get();
  if (frame == nullptr) return "camera returned no frame";
  if (frame->len == 0) {
    esp_camera_fb_return(frame);
    return "camera returned an empty frame";
  }
  out.print("{\"id\":");
  out.print(id);
  out.print(",\"ok\":true,\"mime\":\"image/jpeg\",\"data\":\"");
  // 768 input bytes -> exactly 1024 base64 characters with no padding, so the pieces join up.
  unsigned char encoded[1025];
  for (size_t offset = 0; offset < frame->len; offset += 768) {
    size_t chunk = frame->len - offset;
    if (chunk > 768) chunk = 768;
    size_t written = 0;
    mbedtls_base64_encode(encoded, sizeof(encoded), &written, frame->buf + offset, chunk);
    out.write(encoded, written);
  }
  out.println("\"}");
  esp_camera_fb_return(frame);
  return nullptr;
}
#else
static bool g_cameraReady = false;
static void cameraBegin() {}
static const char *cameraCaptureTo(Stream &, long) { return "unsupported"; }
#endif
