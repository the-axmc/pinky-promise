# Connecting the hardware

Everything in this repository runs today with a simulated device. This guide is for the day the
parts arrive: it gets a real board talking to the same system, **one part at a time**, with
whatever is not wired yet still simulated.

## Where this stands

| Piece | Status |
| --- | --- |
| Host side (`packages/device`): every part as a swappable seam, serial bridge, bring-up probe, CLI | **Tested** — 79 tests, plus the whole custody journey run through the bridge protocol against an in-memory board |
| Firmware (`firmware/pinky-bridge`) | **Written, not yet compiled or run on a board.** The machine it was written on had no ESP32 toolchain. It passes a syntax/type check against stub headers (see below), which is weaker than a build. Expect to fix small things on first compile. |
| Any run with physical parts | **Not done.** No hardware was attached. |

The firmware's least certain part is the optional BLE link; its most consequential is the
one-time ATECC608B provisioning, which cannot be undone. Both are off unless you ask for them.

## How it fits together

The device's logic (sequence numbers, signing order, what it agrees to sign) lives on the host,
in `packages/device`. The board is the hardware half: the `pinky-bridge` firmware exposes each
part as one command over USB serial, and the host calls them.

```
 SHT31 ─┐
 GPS ───┤                         USB serial            packages/device            gateway
 camera ┼─ ESP32-S3 (pinky-bridge) ─────────────  host: Device + bridge  ─ HTTP ─  (Arkiv, 0G,
 ATECC ─┤   wallet key in flash    JSON lines                                       Hedera)
 PN532 ─┘
```

Each part has a simulated twin. At start the host asks the board which parts answered and uses
those; the rest stay simulated. Wiring a part therefore needs no code change — it shows up as
`REAL (board)` on the next start.

This is a tethered setup: the board needs the host. Moving the device logic onto the ESP32 so it
talks to the gateway by itself over BLE or WiFi is the next step, described at the end.

## The parts

| Part | What it gives the system | How the board finds it | Bridge command |
| --- | --- | --- | --- |
| ESP32-S3 board | The device wallet (secp256k1 key, generated on first boot, kept in flash) | always | `wallet.info`, `wallet.sign` |
| SHT31 breakout | Temperature and humidity of every reading | answers on I2C `0x44` | `climate.read` |
| GPS module (NEO-M8N or NEO-6M) | Position, committed to in each reading and proven in zero knowledge | NMEA characters arrive on the UART | `gps.read` |
| Camera (board with a camera connector) | The seal photo the vision model judges at each handoff | camera initialises | `camera.capture` |
| ATECC608B breakout | Hardware root key: signs the certificate that binds the wallet to this chip | answers on I2C `0x60`, and is provisioned | `se.info`, `se.sign` |
| PN532 NFC module | Reads an NFC seal tag (NTAG): the same tag is still there, or it is gone | answers on I2C `0x24` | `nfc.read` |
| Tamper switch (optional) | Whether the device's own case was opened, and how often | cannot be detected: build flag | `enclosure.read` |
| Second ESP32-S3 | The venue anchor: co-signs a nonce, showing the device was at the venue | flashed with the anchor build | `anchor.attest` |
| Breadboard, jumpers, two USB-C **data** cables | — | — | — |

### Which board

The camera needs a board with a camera connector. A plain ESP32-S3 DevKitC has none.

- **Seeed XIAO ESP32S3 Sense** — recommended for the device. It has the camera and eleven header
  pins, which is enough for everything in the table.
- **ESP32-S3-DevKitC-1** — fine for the anchor, and for a device without a camera. Take the seal
  photo with a phone instead and pass `--photos <folder>` (the newest image in the folder is
  used; the record says the photo came from a file, not from the device).
- **ESP32-S3-EYE** — the camera pin map is included, but the board has no general pin header and
  its sensor pins are deliberately left unassigned in `config.h`. Check the schematic before
  wiring anything to it.

## Wiring

Everything runs at 3.3 V. SHT31, ATECC608B and PN532 share one I2C bus (their addresses do not
collide). Pin numbers can be changed with `-D` flags; the defaults are in
[`firmware/pinky-bridge/pinky-bridge/config.h`](../firmware/pinky-bridge/pinky-bridge/config.h).

### Seeed XIAO ESP32S3 Sense (device)

| Board pin | GPIO | Connect to |
| --- | --- | --- |
| 3V3 | — | VIN/VCC of SHT31, ATECC608B, PN532, GPS |
| GND | — | GND of everything |
| D4 | 5 | SDA of SHT31, ATECC608B, PN532 |
| D5 | 6 | SCL of SHT31, ATECC608B, PN532 |
| D7 | 44 | **TX** of the GPS module |
| D6 | 43 | **RX** of the GPS module |
| D1 | 2 | PN532 IRQ |
| D3 | 4 | PN532 RSTO / RSTPDN |
| D0 | 1 | tamper switch, other leg to GND |
| D8, D9, D10 | 7, 8, 9 | free (optional green / amber / red LEDs through resistors) |

The camera sits on the Sense expansion board and uses none of the header pins. The on-board
orange LED shows the status.

### ESP32-S3-DevKitC-1 (anchor, or a device without camera)

| GPIO | Connect to |
| --- | --- |
| 3V3, GND | power for the modules |
| 8 | SDA |
| 9 | SCL |
| 18 | **TX** of the GPS module |
| 17 | **RX** of the GPS module |
| 5 | PN532 IRQ |
| 6 | PN532 RSTO |
| 4 | tamper switch, other leg to GND |
| 10, 11, 12 | green, amber, red status LEDs (each through a resistor to GND) |

An anchor needs no wiring at all: just the board and power.

### Notes on the modules

- **PN532**: set it to I2C mode. On the common red Elechouse board that is DIP switch 1 ON,
  switch 2 OFF; on Adafruit's breakout, SEL0 closed and SEL1 open.
- **GPS**: TX goes to the board's RX pin and RX to its TX pin. The default is 9600 baud; some
  NEO-M8N boards ship at 38400 (build with `-DGPS_BAUD=38400`). A fix needs open sky and can take
  minutes from cold. Indoors there is usually none — see "What changes with real parts".
- **Tamper switch**: any switch that is closed while the case is shut, between the pin and GND.
  Turn it on in the build only once it is wired (`-DPINKY_HAS_ENCLOSURE=1`), otherwise every
  handoff reports an open case.

## Flashing

With [PlatformIO](https://platformio.org/install/cli):

```sh
cd firmware/pinky-bridge
pio run -e xiao-s3-sense -t upload        # device on a XIAO ESP32S3 Sense
pio run -e s3-devkitc -t upload           # device on a DevKitC (no camera)
pio run -e anchor-s3-devkitc -t upload    # venue anchor on a DevKitC
pio run -e anchor-xiao-s3 -t upload       # venue anchor on a XIAO
```

With the Arduino IDE: open `firmware/pinky-bridge/pinky-bridge/pinky-bridge.ino`, choose the
board and role at the top of `config.h`, and install the libraries listed in `platformio.ini`
(ArduinoJson 7, micro-ecc, TinyGPSPlus, SparkFun ATECCX08a, Adafruit PN532, Adafruit BusIO). For
a XIAO, set *USB CDC On Boot: Enabled* and *PSRAM: OPI PSRAM*.

If the first build fails, the error will most likely be in one optional part. Each part has a
switch (`-DPINKY_HAS_GPS=0`, `-DPINKY_HAS_PN532=0`, …), so you can turn the failing one off, keep
going with the rest, and come back to it.

Without the toolchain, this at least checks the code for syntax and type errors:

```sh
sh firmware/pinky-bridge/check/syntax-check.sh -v
```

## Bring-up, one part at a time

Run the probe after every step. It asks each part to do its job once and says what works, what
is failing and what is not there:

```sh
pnpm device ports                              # find the board's port
pnpm device probe --port /dev/cu.usbmodem101   # ✔ works   ✖ failing   · not detected
pnpm device probe --port mock                  # the same against an in-memory board, to see the output
```

1. **The board alone.** Flash it and probe. Expect `✔ device wallet` with an address: the key was
   generated on first boot. Everything else is `· not detected`.
2. **SHT31.** Wire it, probe: `✔ SHT31 … 23.41 °C, 48.20 %RH`.
3. **GPS.** Wire it, probe. `module is talking, no fix yet` means the wiring is right and it needs
   sky. `nothing received` means RX/TX are swapped or the baud rate is wrong.
4. **Camera.** Probe with `--photo seal.jpg` and look at the picture it saved.
5. **ATECC608B.** Probe says `found, but blank`. Read the next section before going further.
6. **PN532.** Probe with a tag on the reader: `✔ PN532 … tag 04a1b2…`.
7. **Tamper switch.** Rebuild with `-DPINKY_HAS_ENCLOSURE=1`, probe, open and close the case.
8. **Anchor.** Flash the second board with an anchor build, then:

   ```sh
   pnpm device anchor-setup --port /dev/cu.usbmodem201 --venue WH-MUM-01
   ```

   It prints the anchor's address, which is what a venue is registered with at the gateway.

### Provisioning the ATECC608B — once, and for good

A chip fresh from the bag is blank. To use it, its configuration is written and **locked
permanently**, a key is generated inside it and that is locked too. There is no undo: a chip
provisioned wrongly is a chip to replace.

```sh
pnpm device provision-se --port /dev/cu.usbmodem101 --lock-forever
```

Before you run it:

- This code path has never been run against a real chip. It calls the SparkFun library's own
  functions in the order of SparkFun's *Example1_Configuration*; if you want the least risk, run
  that example sketch instead — it does the same thing and is widely used — and then come back.
- Do it **before** you enrol the device anywhere you care about. A device's identity is its
  wallet plus its secure element, fixed at enrolment. If you enrol with the secure element
  simulated and add the chip later, the host will refuse to carry the enrolment over and tell you
  to give the device a new wallet (erase the board's flash: `pio run -t erase`, then upload again)
  and enrol it afresh.
- Until the chip is provisioned, the host notices and keeps simulating the secure element, so
  nothing else is blocked. The plan's own fallback applies: a key in flash is enough for a demo.

## Running with hardware

The local demo takes the same flags as the device CLI. Start small:

```sh
pnpm demo --port /dev/cu.usbmodem101                          # real parts where present
pnpm demo --port /dev/cu.usbmodem101 --sim gps,camera         # but keep these two simulated
pnpm demo --port /dev/cu.usbmodem101 --anchor-port /dev/cu.usbmodem201
pnpm demo --interactive --port /dev/cu.usbmodem101            # you press the keys
```

At start it prints, part by part, what is real. `--interactive` gives you the device on the
keyboard: `1`–`4` take the four kinds of handoff, `v` moves between venues, `o` cuts 0G off to
rehearse the safe stop, `i` is the inspector's release.

Against a deployed gateway rather than the local stack:

```sh
pnpm device enroll --gateway https://… --admin-token … --venues WH-MUM-01,DK-PNQ-02 --port …
pnpm device run    --gateway https://… --port …
```

### What changes with real parts

- **Real SHT31.** It reports what it measures, and a desk is not a cold room: against 2–8 °C the
  very first reading would breach. So when the sensor is real, the demo reads it once at start
  and sets the lot's limits around that (8 °C below to 4 °C above, humidity up to at least 70 %),
  and says what it chose. `--temp-range 15:28` sets the band yourself. At the "cooling fails"
  act the script waits up to 90 seconds for an out-of-range reading: hold the sensor in your
  hand or breathe on it (humidity jumps well past the limit).
- **Real camera.** The local stand-in model cannot see: it recognises the simulator's two
  pictures and answers ESCALATE to any other photo, which is the honest thing for it to do. To
  have real photos judged, point the demo at the real 0G model while the chains stay local:

  ```sh
  ZG_ROUTER_URL=https://router-api.0g.ai/v1 ZG_API_KEY=… ZG_MODEL=qwen2.5-vl-72b-instruct pnpm demo --port …
  ```

- **Real GPS.** With a fix, the demo centres the origin venue on where the device actually is, so
  the geofence proof is about a real place. Without one (indoors), readings commit to "no fix"
  and get no proof; the journey still works, because location authenticity comes from the anchor.
  For a demo indoors, `--sim gps` keeps the position simulated.
- **Real anchor.** It is treated as the origin warehouse's anchor. Plugged into the host over USB
  it proves the anchor's key was present at the gateway. Proximity to the *device* needs the BLE
  link below.

## The anchor over BLE

Build **both** boards with `-DPINKY_HAS_BLE=1`. The anchor then needs only power (a USB battery
at the venue). When the device is asked for an attestation it scans, connects, hands over the
nonce and reads back the co-signature — which it can only do within radio range. `--min-rssi -70`
on the host tightens "in range" further.

This is the part of the firmware most likely to need work: it was written from memory of the
ESP32 Arduino BLE API and never run. It may also need a larger app partition
(`board_build.partitions = huge_app.csv`).

## The NFC tag

Today the PN532 reads the UID of the tag under it at each handoff, and the checkpoint records it.
That detects a seal tag that is gone, or swapped for a different one. If the reader finds no tag,
the record says so and counts as tampering — at a handoff the tag is supposed to be there.

What it does not do yet:

- It does not read the tamper loop of an NTAG 213 TT or NTAG 424 DNA TagTamper; the tamper state
  is always reported as unknown.
- A plain NTAG's UID can be cloned, so the tag is evidence, not proof.
- Using an NFC tag as the *venue anchor* (tap the device on a tag bolted to the dock) is not
  implemented. It would need an NTAG 424 DNA, whose reads carry a cryptographic message the
  gateway can check; a plain NTAG there would prove nothing.

## Limits to keep in mind

- **The host is the brain.** Sequence counters and the signing policy run on the host; the board
  holds the keys and reads the sensors. Fine for a demo; a deployed device must do it all itself.
- **The wallet key is in the ESP32's flash**, unencrypted unless flash encryption is enabled. The
  ATECC608B is the root that cannot be copied; the wallet is as safe as the board.
- **Library licences.** The SparkFun ATECC library is GPL and TinyGPS++ is LGPL. That matters if
  you distribute firmware binaries, not for using the source here.

## Next: a standalone device

To cut the tether, the logic in `packages/device/src/device.ts` moves onto the ESP32. Its header
lists the four behaviours firmware must reproduce (never reuse a sequence number; sign exactly
the documented layouts; trust limits only from a registry-signed profile; sign an Arkiv
transaction only after checking what it says). [`device-protocol.md`](device-protocol.md) has the
byte layouts, and `contracts/vectors/protocol-v1.json` has test vectors that the TypeScript and
the Solidity implementations already agree on — a firmware port is correct when it reproduces
them.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `the board did not answer within 10000 ms` | Wrong port; a charge-only USB cable; another program (a serial monitor) holding the port; on a XIAO, *USB CDC On Boot* not enabled |
| No port appears | Hold BOOT while plugging in, flash again |
| A part is `· not detected` | Power and ground first; then SDA/SCL swapped; for the PN532, the mode switches |
| `sht31 crc` | Loose wire or long jumpers on the I2C bus |
| GPS `nothing received` | RX/TX swapped, or the module is at 38400 baud |
| Every handoff ESCALATEs | Real photos with the stand-in model — use the real 0G model or `--sim camera` |
| Every handoff reports tampering | `PINKY_HAS_ENCLOSURE=1` with no switch wired, or no seal tag on the PN532 |
| `enrolled with a different secure element` | The secure element changed after enrolment — see the provisioning section |
