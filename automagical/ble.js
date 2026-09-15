// ble.js - talks to a MeshCore companion over Web Bluetooth, like the phone app.
//
// The companion's BLE build (companion_radio_ble) exposes a Nordic UART Service
// (src/helpers/esp32/SerialBLEInterface.cpp and nrf52/SerialBLEInterface.cpp):
//
// - service 6E400001-B5A3-F393-E0A9-E50E24DCCA9E, advertised, device name
//   "MeshCore-<node name>";
// - RX 6E400002-… (write): one GATT write = one companion frame (no '<'/length
//   header as on USB);
// - TX 6E400003-… (notify): one notification = one frame;
// - both require an encrypted, MITM-protected link, so the first access makes
//   the OS show a pairing dialog for the device's PIN (random and shown on
//   the display for boards that have one and no PIN set, else 123456 or the
//   PIN set in the app);
// - MTU is negotiated to the 176-byte frame size, so frames are never split.
//
// Repeaters and room servers have no BLE interface at all - this transport is
// for companions only. Web Bluetooth exists in Chrome/Edge (Linux behind a
// flag), not in Firefox or Safari.

import { CompanionLink } from "./serial.js";

export const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
export const BLE_NAME_PREFIX = "MeshCore-";

export function bluetoothSupported() {
  return typeof navigator !== "undefined" && !!navigator.bluetooth;
}

export class MeshCoreBle extends CompanionLink {
  constructor(opts = {}) {
    super(opts);
    this.kind = "ble";
    this.device = null;
    this.rx = null;
    this.tx = null;
  }

  // Opens the browser's device picker (must be called from a user gesture),
  // connects, and subscribes to notifications - which triggers pairing.
  async connect() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE] }, { namePrefix: BLE_NAME_PREFIX }],
      optionalServices: [NUS_SERVICE]
    });
    this.device = device;
    this.onLog("info", "Forbinder til " + (device.name || "BLE-enhed") + " …");
    device.addEventListener("gattserverdisconnected", () => {
      this.connected = false;
      this.onLog("info", "Bluetooth-forbindelsen blev afbrudt.");
    });
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    this.rx = await service.getCharacteristic(NUS_RX);
    this.tx = await service.getCharacteristic(NUS_TX);
    this.tx.addEventListener("characteristicvaluechanged", e => {
      const v = e.target.value;
      this.receiveFrame(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
    });
    await this.tx.startNotifications(); // first encrypted access -> pairing / PIN dialog
    this.connected = true;
    this.onLog("info", "Forbundet via Bluetooth til " + (device.name || "BLE-enhed"));
  }

  async disconnect() {
    this.connected = false;
    try { if (this.tx) await this.tx.stopNotifications(); } catch (e) { /* ignore */ }
    try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { /* ignore */ }
    this.device = null;
    this.rx = null;
    this.tx = null;
  }

  // --- companion frames over GATT: one write = one frame ---
  async sendFrame(payload) {
    if (this.rx.properties.write && this.rx.writeValueWithResponse) return this.rx.writeValueWithResponse(payload);
    if (this.rx.writeValueWithoutResponse) return this.rx.writeValueWithoutResponse(payload);
    return this.rx.writeValue(payload);
  }

  // Over Bluetooth there is only the companion protocol.
  async identify() {
    const companion = await this.companionQuery();
    return companion ? { kind: "companion", ...companion } : { kind: "unknown" };
  }

  async command(cmd) {
    throw new Error("Bluetooth-forbindelsen har ingen tekst-CLI (" + cmd + ")");
  }
}
