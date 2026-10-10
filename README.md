# BNB Flasher

Local Angular and Node.js tool for configuring and flashing the BNB master and ESP32-C5 scanner firmware over USB serial.

## Run locally

Requirements: Node.js 22+, npm, the BNBDriverMaster firmware checkout, and ESP-IDF 6.1 with the `esp32` and `esp32c5` targets installed.

```sh
export PATH="$HOME/.local/share/nodejs/node-v22.23.3-linux-x64/bin:$PATH"
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. The API only binds to `127.0.0.1`; firmware builds use ESP-IDF's `idf.py` and flash the selected serial port after a successful build.

By default, the firmware checkout is expected at `../BNBDriverMaster` and ESP-IDF at `~/.espressif/v6.1/esp-idf`. Override either location in the server environment with `FIRMWARE_ROOT` or `IDF_PATH`.

The flasher copies each target's existing `sdkconfig` into a temporary job directory, changes only the controls shown in the UI, and builds there. The firmware checkout's `sdkconfig` and normal build directories are not modified.

On Linux, the user running the app must have permission to access the board's USB serial device (commonly through the `dialout` group). Connect the board and refresh the port list before flashing.

## Firmware profiles

- **Master:** BLE device name, UART port/pins/baud, and ESP-NOW channel.
- **Wired scanner:** UART port/pins/baud.
- **Wireless scanner:** ESP-NOW channel.

The scanner transport and target chip are selected by the profile. A flash job configures, builds, then flashes the chosen device; it never erases the entire flash chip.