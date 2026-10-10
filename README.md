# BNB Flasher

Static Angular flasher for the BNB master and ESP32-C5 scanners. The browser communicates directly with USB serial devices through Web Serial and Espressif's `esptool-js`; no local API server or ESP-IDF install is required.

## Run locally

Requirements: Node.js 22+, npm, and a Web Serial-capable desktop browser such as current Chrome or Edge.

```sh
export PATH="$HOME/.local/share/nodejs/node-v22.23.3-linux-x64/bin:$PATH"
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. On first use, select **Choose USB device** and grant the page permission to access the connected board. Browsers require HTTPS for hosted sites; localhost is treated as secure for development.

## Static deployment

Run `npm run build`, then deploy `client/dist/bnb-flasher-ui/browser` to any static host. For example, Cloudflare Pages can use `client` as the project root, `npm run build` as the build command, and `dist/bnb-flasher-ui/browser` as the output directory. The firmware images are included from `client/public/firmwares`.

### GitHub Pages

This repository includes a GitHub Actions deployment workflow. In the repository, open **Settings → Pages** and set the source to **GitHub Actions**. Push to `master` (or run the workflow manually); the site will deploy to <https://byachna.github.io/BNBFlasherApp/>. The build sets Angular's base href to the project-site path so firmware downloads resolve correctly.

Web Serial only lists ports the user has granted to this site. The user must initiate port selection from a click; the browser does not allow silent access to arbitrary USB devices. Safari is not supported by Web Serial. The **Source Built Firmware** tab is intentionally disabled; this app flashes the precompiled bundles only.

## Precompiled profiles

- **Master:** BLE name `BNB-WarDriver`, UART1 on GPIO17/16 at 921600 baud, ESP-NOW channel 1.
- **Wired scanner:** UART1 on GPIO8/9 at 921600 baud.
- **Wireless scanner:** ESP-NOW channel 1.

The profile selects the target chip and its bootloader, partition table, and application image. `esptool-js` detects the attached chip before writing, reports progress in the job console, and resets the device after flashing. It does not erase the entire flash chip.