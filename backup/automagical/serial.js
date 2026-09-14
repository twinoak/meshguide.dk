// serial.js - talks to a MeshCore repeater's CLI over Web Serial.
//
// The repeater's serial console (examples/simple_repeater/main.cpp in the
// MeshCore firmware) works like this:
//
// - a command is terminated by '\r' ('\n' is ignored);
// - every character we send is echoed back, and a '\n' is printed when the
//   line is complete;
// - the reply (if any) is printed as "  -> " + reply + "\r\n". A reply is at
//   most 160 bytes and may itself contain newlines (e.g. the region tree);
// - "get <x>" replies "> <value>", most "set" commands reply "OK",
//   unknown commands reply "Unknown command" / "unknown config: <x>".
//
// There is no end-of-reply marker, so a command is considered answered when
// the device has been quiet for QUIET_MS after the last received line.
//
// The companion firmware (the one used with the phone app) has no text CLI at
// all: it speaks a binary framed protocol on the same port ('<' + 16-bit
// length + payload in, '>' + length + payload out). identify() tells the two
// apart, so the page can say "this is a companion" instead of timing out.

const QUIET_MS = 200;        // silence after a "-> " reply line = reply complete
const NO_REPLY_MS = 800;     // silence after only the echo = command gave no reply
const DEFAULT_TIMEOUT_MS = 2500;
const REPLY_PREFIX = "-> ";

// Companion protocol (examples/companion_radio/MyMesh.cpp + helpers/ArduinoSerialInterface.cpp)
export const CMD_APP_START = 1;
export const CMD_DEVICE_QUERY = 22;
export const CMD_SET_PATH_HASH_MODE = 61;
export const CMD_SET_DEFAULT_FLOOD_SCOPE = 63;
export const CMD_GET_DEFAULT_FLOOD_SCOPE = 64;
export const RESP_CODE_OK = 0;
export const RESP_CODE_ERR = 1;
export const RESP_CODE_SELF_INFO = 5;
export const RESP_CODE_DEVICE_INFO = 13;
export const RESP_CODE_DEFAULT_FLOOD_SCOPE = 28;
const ADV_TYPES = { 1: "companion", 2: "repeater", 3: "room", 4: "sensor" };

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function serialSupported() {
  return typeof navigator !== "undefined" && !!navigator.serial;
}

// --- Companion frames ---------------------------------------------------------

export function companionFrame(payload) {
  const b = new Uint8Array(3 + payload.length);
  b[0] = 0x3C; // '<'
  b[1] = payload.length & 0xff;
  b[2] = payload.length >> 8;
  b.set(payload, 3);
  return b;
}

// Extracts the payloads of all '>'-frames in a byte buffer.
export function parseCompanionFrames(bytes) {
  const out = [];
  let i = 0;
  while (i + 3 <= bytes.length) {
    if (bytes[i] !== 0x3E) { i++; continue; } // '>'
    const len = bytes[i + 1] | (bytes[i + 2] << 8);
    if (len === 0 || len > 176 || i + 3 + len > bytes.length) { i++; continue; }
    out.push(bytes.slice(i + 3, i + 3 + len));
    i += 3 + len;
  }
  return out;
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

function cstr(bytes, start, len) {
  let end = start;
  while (end < start + len && end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.slice(start, end));
}

function i32(bytes, at) {
  return new DataView(bytes.buffer, bytes.byteOffset).getInt32(at, true);
}
function u32(bytes, at) {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);
}

// RESP_CODE_DEVICE_INFO: [13, fw_ver_code, max_contacts/2, max_channels, ble_pin(4), build_date(12), board(40), fw_version(20), repeat_en, path_hash_mode]
export function parseDeviceInfo(p) {
  if (p[0] !== RESP_CODE_DEVICE_INFO || p.length < 60) return null;
  return {
    firmwareVerCode: p[1],
    buildDate: cstr(p, 8, 12),
    board: cstr(p, 20, 40),
    firmwareVersion: p.length >= 80 ? cstr(p, 60, 20) : null,
    repeatEnabled: p.length > 80 ? p[80] === 1 : null,
    pathHashMode: p.length > 81 ? p[81] : null
  };
}

// RESP_CODE_DEFAULT_FLOOD_SCOPE: [28] when unset, else [28, name(31, NUL-padded), key(16)]
export function parseDefaultScope(p) {
  if (p[0] !== RESP_CODE_DEFAULT_FLOOD_SCOPE) return null;
  if (p.length < 48) return { name: null, key: null };
  return { name: cstr(p, 1, 31), key: [...p.slice(32, 48)].map(b => b.toString(16).padStart(2, "0")).join("") };
}

// CMD_SET_DEFAULT_FLOOD_SCOPE: [63, name(31, NUL-padded), key(16)]
export function setDefaultScopePayload(name, key16) {
  const p = new Uint8Array(1 + 31 + 16);
  p[0] = CMD_SET_DEFAULT_FLOOD_SCOPE;
  new TextEncoder().encodeInto(name, p.subarray(1, 31));
  p.set(key16, 32);
  return p;
}

// CMD_SET_PATH_HASH_MODE: [61, 0, mode]
export function setPathHashModePayload(mode) {
  return Uint8Array.from([CMD_SET_PATH_HASH_MODE, 0, mode]);
}

// RESP_CODE_SELF_INFO: [5, adv_type, tx_power, max_tx, pubkey(32), lat(i32 *1e6), lon(i32 *1e6), multi_acks, adv_loc_policy, telemetry, manual_add, freq(u32 kHz), bw(u32 Hz), sf, cr, name...]
export function parseSelfInfo(p) {
  if (p[0] !== RESP_CODE_SELF_INFO || p.length < 58) return null;
  return {
    type: ADV_TYPES[p[1]] || String(p[1]),
    txPower: (p[2] << 24) >> 24,
    publicKey: [...p.slice(4, 36)].map(b => b.toString(16).padStart(2, "0")).join(""),
    lat: i32(p, 36) / 1e6,
    lon: i32(p, 40) / 1e6,
    advertLocPolicy: p[45],
    radio: { freq: u32(p, 48) / 1000, bw: u32(p, 52) / 1000, sf: p[56], cr: p[57] },
    name: new TextDecoder().decode(p.slice(58))
  };
}

// Turns the raw lines received after a command into a structured reply.
export function parseReply(cmd, lines) {
  const out = { cmd, lines, reply: null, value: null, ok: false, unsupported: false };
  let i = lines.findIndex(l => l.trimStart().startsWith(REPLY_PREFIX));
  if (i < 0) return out;
  const first = lines[i].trimStart().slice(REPLY_PREFIX.length);
  const rest = lines.slice(i + 1);
  // Drop trailing empty lines; keep the middle (multi-line replies are indented trees).
  while (rest.length && rest[rest.length - 1].trim() === "") rest.pop();
  out.reply = [first, ...rest].join("\n");
  out.unsupported = /^unknown (command|config)/i.test(first);
  out.ok = !out.unsupported && !/^(err\b|error\b|error,|err -)/i.test(first.trim());
  if (first.startsWith("> ")) out.value = first.slice(2);
  else if (first === ">") out.value = "";
  return out;
}

export class MeshCoreSerial {
  constructor({ onLog } = {}) {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = "";
    this.pending = null;
    this.binary = null;   // when set (an array), incoming bytes are captured raw instead of decoded as text
    this.onLog = onLog || (() => {});
    this.encoder = new TextEncoder();
    this.connected = false;
  }

  // Opens a port chosen by the user (must be called from a user gesture).
  async connect(baudRate = 115200) {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate });
    // DTR must be asserted for nRF52 boards (USB CDC drops output otherwise);
    // asserting both DTR and RTS keeps ESP32 auto-reset circuits in "run".
    try { await port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch (e) { this.onLog("info", "setSignals: " + e); }
    this.port = port;
    this.writer = port.writable.getWriter();
    this.connected = true;
    this.reading = this.readLoop(); // runs until the port closes
    // Some boards reset when the port opens; give boot output time to arrive
    // and let it drain into the log before we start talking.
    await sleep(1200);
    this.buffer = "";
    port.addEventListener("disconnect", () => { this.connected = false; this.onLog("info", "Enheden blev frakoblet."); });
  }

  async disconnect() {
    this.connected = false;
    try { if (this.reader) await this.reader.cancel(); } catch (e) { /* ignore */ }
    try { if (this.reading) await this.reading; } catch (e) { /* ignore */ }
    try { if (this.writer) { this.writer.releaseLock(); this.writer = null; } } catch (e) { /* ignore */ }
    try { if (this.port) await this.port.close(); } catch (e) { this.onLog("info", "close: " + e); }
    this.port = null;
    this.reading = null;
  }

  async readLoop() {
    const decoder = new TextDecoder();
    while (this.port && this.port.readable && this.connected) {
      this.reader = this.port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (this.binary) {
            this.binary.push(value);
            this.onLog("rx", "[" + value.length + " B binær] " + [...value.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join(" ") + (value.length > 16 ? " …" : ""));
            continue;
          }
          this.feed(decoder.decode(value, { stream: true }));
        }
      } catch (e) {
        this.onLog("error", "Læsefejl: " + e);
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
      if (!this.connected) break;
    }
  }

  feed(text) {
    this.buffer += text;
    let i;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, "");
      this.buffer = this.buffer.slice(i + 1);
      this.onLog("rx", line);
      if (this.pending) {
        this.pending.lines.push(line);
        this.pending.lastLine = performance.now();
      }
    }
  }

  // Sends one command and returns the parsed reply.
  async command(cmd, { timeoutMs = DEFAULT_TIMEOUT_MS, quietMs = QUIET_MS } = {}) {
    if (!this.writer) throw new Error("Ikke forbundet");
    this.onLog("tx", cmd);
    const pending = { lines: [], lastLine: performance.now() };
    this.pending = pending;
    await this.writer.write(this.encoder.encode(cmd + "\r"));
    const start = performance.now();
    while (true) {
      await sleep(50);
      const now = performance.now();
      const quiet = now - pending.lastLine;
      const hasReply = pending.lines.some(l => l.trimStart().startsWith(REPLY_PREFIX));
      if (hasReply && quiet >= quietMs) break;
      if (!hasReply && pending.lines.length && quiet >= NO_REPLY_MS) break;
      if (now - start >= timeoutMs) break;
    }
    this.pending = null;
    // The echo of our own command comes back as a line of its own; drop it.
    const lines = pending.lines.filter(l => l !== cmd);
    return parseReply(cmd, lines);
  }

  // "get <name>" -> the value string, or null when the firmware does not know the setting.
  async get(name) {
    const r = await this.command("get " + name);
    return r.value;
  }

  // Sends one companion frame and returns the payloads of the frames that come
  // back: waits for at least one complete frame (or the timeout), then a short
  // quiet period so a second frame is not cut off.
  async companionCommand(payload, label, { timeoutMs = 1500, quietMs = 150 } = {}) {
    if (!this.writer) throw new Error("Ikke forbundet");
    this.onLog("tx", "<" + label + ">");
    this.binary = [];
    await this.writer.write(companionFrame(payload));
    const start = performance.now();
    let frames = [];
    let lastLen = 0, lastChange = start;
    while (true) {
      await sleep(50);
      const now = performance.now();
      const total = this.binary.reduce((n, c) => n + c.length, 0);
      if (total !== lastLen) { lastLen = total; lastChange = now; }
      if (total) frames = parseCompanionFrames(concat(this.binary));
      if (frames.length && now - lastChange >= quietMs) break;
      if (now - start >= timeoutMs) break;
    }
    this.binary = null;
    for (const f of frames) this.onLog("info", "frame kode " + f[0] + " (" + f.length + " B)");
    return frames;
  }

  // Sends the companion app's two hello frames. Returns { deviceInfo, selfInfo }
  // (either may be null) or null if nothing frame-shaped answered.
  async companionQuery() {
    const a = await this.companionCommand(Uint8Array.from([CMD_DEVICE_QUERY, 1]), "CMD_DEVICE_QUERY");
    const b = await this.companionCommand(Uint8Array.from([CMD_APP_START, 0, 0, 0, 0, 0, 0, 0, ...this.encoder.encode("meshguide")]), "CMD_APP_START meshguide");
    const frames = [...a, ...b];
    const dev = frames.map(parseDeviceInfo).find(Boolean) || null;
    const self = frames.map(parseSelfInfo).find(Boolean) || null;
    return dev || self ? { deviceInfo: dev, selfInfo: self } : null;
  }

  // { name, key } of the companion's default flood scope; name null when unset;
  // null when the firmware did not answer (too old for the command).
  async companionGetDefaultScope() {
    const frames = await this.companionCommand(Uint8Array.from([CMD_GET_DEFAULT_FLOOD_SCOPE]), "CMD_GET_DEFAULT_FLOOD_SCOPE");
    return frames.map(parseDefaultScope).find(Boolean) || null;
  }

  // Sends a companion write command; true on RESP_CODE_OK.
  async companionSet(payload, label) {
    const frames = await this.companionCommand(payload, label);
    const err = frames.find(f => f[0] === RESP_CODE_ERR);
    if (err) this.onLog("error", label + ": fejlkode " + err[1]);
    return frames.some(f => f[0] === RESP_CODE_OK && f.length === 1);
  }

  // Works out what is on the other end:
  //   { kind: "cli", version, role }              - repeater / room server / sensor firmware (text CLI)
  //   { kind: "companion", deviceInfo, selfInfo } - companion firmware (binary protocol)
  //   { kind: "unknown" }                         - nothing answered
  // Text is probed first: a repeater would keep a binary frame in its line
  // buffer, so the binary probe only runs when the text CLI is silent, and a
  // bare "\r" flushes the buffer afterwards.
  async identify() {
    await this.command("", { timeoutMs: 600 }); // flush any half-typed line on the device
    const ver = await this.command("ver", { timeoutMs: 1500 });
    if (ver.reply && /\d+\.\d+/.test(ver.reply)) {
      const role = await this.command("get role", { timeoutMs: 1500 });
      return { kind: "cli", version: ver.reply, role: role.value };
    }
    const companion = await this.companionQuery();
    if (companion) return { kind: "companion", ...companion };
    await this.command("", { timeoutMs: 600 });
    return { kind: "unknown" };
  }
}
