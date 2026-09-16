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
export const CMD_SEND_TXT_MSG = 2;
export const CMD_GET_CONTACTS = 4;
export const CMD_GET_DEVICE_TIME = 5;
export const CMD_SET_DEVICE_TIME = 6;
export const CMD_SET_ADVERT_NAME = 8;
export const CMD_ADD_UPDATE_CONTACT = 9;
export const CMD_SYNC_NEXT_MESSAGE = 10;
export const CMD_DEVICE_QUERY = 22;
export const CMD_SEND_LOGIN = 26;
export const CMD_SEND_CONTROL_DATA = 55;
export const CMD_SET_AUTOADD_CONFIG = 58;
export const CMD_GET_AUTOADD_CONFIG = 59;
export const CMD_SET_PATH_HASH_MODE = 61;
export const CMD_SET_DEFAULT_FLOOD_SCOPE = 63;
export const CMD_GET_DEFAULT_FLOOD_SCOPE = 64;
export const RESP_CODE_AUTOADD_CONFIG = 25;
export const RESP_CODE_OK = 0;
export const RESP_CODE_ERR = 1;
export const RESP_CODE_CONTACTS_START = 2;
export const RESP_CODE_CONTACT = 3;
export const RESP_CODE_END_OF_CONTACTS = 4;
export const RESP_CODE_SELF_INFO = 5;
export const RESP_CODE_SENT = 6;
export const RESP_CODE_CONTACT_MSG_RECV = 7;
export const RESP_CODE_CHANNEL_MSG_RECV = 8;
export const RESP_CODE_CURR_TIME = 9;
export const RESP_CODE_NO_MORE_MESSAGES = 10;
export const RESP_CODE_DEVICE_INFO = 13;
export const RESP_CODE_CONTACT_MSG_RECV_V3 = 16;
export const RESP_CODE_CHANNEL_MSG_RECV_V3 = 17;
export const RESP_CODE_DEFAULT_FLOOD_SCOPE = 28;
export const PUSH_CODE_SEND_CONFIRMED = 0x82;
export const PUSH_CODE_MSG_WAITING = 0x83;
export const PUSH_CODE_LOGIN_SUCCESS = 0x85;
export const PUSH_CODE_LOGIN_FAIL = 0x86;
export const PUSH_CODE_CONTROL_DATA = 0x8E;
export const CTL_TYPE_NODE_DISCOVER_REQ = 0x80;
export const CTL_TYPE_NODE_DISCOVER_RESP = 0x90;
export const ADV_TYPE_REPEATER = 2;
export const TXT_TYPE_PLAIN = 0;
export const TXT_TYPE_CLI_DATA = 1;
export const MAX_TEXT_LEN = 160; // BaseChatMesh.h: 10 cipher blocks
export const ERR_CODES = { 1: "kommandoen understøttes ikke", 2: "kontakten findes ikke", 3: "tabellen er fuld", 4: "optaget", 5: "fil-fejl", 6: "ugyldigt argument" };
const ADV_TYPES = { 1: "companion", 2: "repeater", 3: "room", 4: "sensor" };
const MAX_FRAME = 176;
const PUSH_INBOX_MAX = 50;

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

// Splits a byte stream into complete '>'-frames. Returns { frames, rest }: the
// payloads found, and the unconsumed tail (a frame whose bytes have not all
// arrived yet). Bytes that are not the start of a plausible frame are skipped.
export function extractFrames(bytes) {
  const frames = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0x3E) { i++; continue; } // '>'
    if (i + 3 > bytes.length) break;           // header not complete yet
    const len = bytes[i + 1] | (bytes[i + 2] << 8);
    if (len === 0 || len > MAX_FRAME) { i++; continue; }
    if (i + 3 + len > bytes.length) break;     // payload not complete yet
    frames.push(bytes.slice(i + 3, i + 3 + len));
    i += 3 + len;
  }
  return { frames, rest: bytes.slice(i) };
}

// Extracts the payloads of all complete '>'-frames in a byte buffer.
export function parseCompanionFrames(bytes) {
  return extractFrames(bytes).frames;
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

// The companion's auto-add settings (CMD_GET/SET_AUTOADD_CONFIG): a bit mask -
// 0x01 overwrite the oldest non-favourite contact when the list is full, 0x02
// auto-add chat nodes, 0x04 repeaters, 0x08 room servers, 0x10 sensors - plus a
// max hop count. RESP_CODE_AUTOADD_CONFIG: [25, config, max_hops].
export const AUTOADD_OVERWRITE_OLDEST = 0x01;
export function parseAutoAddConfig(p) {
  if (p[0] !== RESP_CODE_AUTOADD_CONFIG || p.length < 3) return null;
  return { config: p[1], maxHops: p[2] };
}
// CMD_SET_AUTOADD_CONFIG: [58, config, max_hops]
export function setAutoAddConfigPayload(config, maxHops) {
  return Uint8Array.from([CMD_SET_AUTOADD_CONFIG, config & 0xff, maxHops & 0xff]);
}

// CMD_SET_ADVERT_NAME: [8, name…] - the firmware keeps the first 31 bytes.
export function setAdvertNamePayload(name) {
  return Uint8Array.from([CMD_SET_ADVERT_NAME, ...new TextEncoder().encode(name)]);
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
    manualAddContacts: p[47],   // bit 0: "Auto Add Selected" (the types in the auto-add config) rather than "Auto Add All"
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

// A path length byte packs the hash size into the top two bits (Packet.h:
// getPathHashSize() = (len >> 6) + 1, getPathHashCount() = len & 63), so 0x4A
// is 10 hops of 2-byte hashes, not 74 hops. 0xFF means no path / not flooded.
export function decodePathLen(raw) {
  if (raw === 0xFF) return { hops: -1, hashSize: null };
  return { hops: raw & 63, hashSize: (raw >> 6) + 1 };
}

// RESP_CODE_CONTACT: [3, pubkey(32), type, flags, out_path_len, out_path(64), name(32), last_advert(u32), lat(i32 *1e6), lon(i32 *1e6), lastmod(u32)]
export function parseContact(p) {
  if (p[0] !== RESP_CODE_CONTACT || p.length < 148) return null;
  const path = decodePathLen(p[35]);
  return {
    publicKey: [...p.slice(1, 33)].map(b => b.toString(16).padStart(2, "0")).join(""),
    typeCode: p[33],
    type: ADV_TYPES[p[33]] || String(p[33]),
    flags: p[34],
    outPathLen: path.hops,                     // hops; -1 = no known path (flood)
    outPathHashSize: path.hashSize,            // bytes per hop hash (1-3), null when no path
    name: cstr(p, 100, 32),
    lastAdvert: u32(p, 132),
    lat: i32(p, 136) / 1e6,
    lon: i32(p, 140) / 1e6,
    lastMod: u32(p, 144)
  };
}

// RESP_CODE_CONTACT_MSG_RECV (7): [7, prefix(6), path_len, txt_type, sender_timestamp(4), text]
// RESP_CODE_CONTACT_MSG_RECV_V3 (16): [16, snr, r1, r2, prefix(6), path_len, txt_type, sender_timestamp(4), text]
export function parseContactMessage(p) {
  let i;
  if (p[0] === RESP_CODE_CONTACT_MSG_RECV) i = 1;
  else if (p[0] === RESP_CODE_CONTACT_MSG_RECV_V3) i = 4;
  else return null;
  if (p.length < i + 12) return null;
  return {
    prefix: [...p.slice(i, i + 6)].map(b => b.toString(16).padStart(2, "0")).join(""),
    pathLen: decodePathLen(p[i + 6]).hops,     // hops the message flooded through; -1 = sent direct
    txtType: p[i + 7],
    senderTimestamp: u32(p, i + 8),
    text: new TextDecoder().decode(p.slice(i + 12))
  };
}

// RESP_CODE_SENT: [6, sent_as_flood, expected_ack(4), est_timeout_ms(4)]
// (expected_ack is 0 for CLI_DATA messages, which are never acknowledged)
export function parseSent(p) {
  if (p[0] !== RESP_CODE_SENT || p.length < 10) return null;
  return { flood: p[1] === 1, ack: u32(p, 2), estTimeoutMs: u32(p, 6) };
}

// PUSH_CODE_SEND_CONFIRMED: [0x82, ack(4), round_trip_ms(4)] - the recipient acknowledged a plain text message
export function parseAck(p) {
  if (p[0] !== PUSH_CODE_SEND_CONFIRMED || p.length < 9) return null;
  return { ack: u32(p, 1), tripMs: u32(p, 5) };
}

// RESP_CODE_CURR_TIME: [9, epoch_seconds(4)]
export function parseCurrTime(p) {
  if (p[0] !== RESP_CODE_CURR_TIME || p.length < 5) return null;
  return u32(p, 1);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// CMD_SEND_LOGIN: [26, pubkey(32), password]
export function loginPayload(publicKeyHex, password) {
  const pw = new TextEncoder().encode(password);
  const p = new Uint8Array(33 + pw.length);
  p[0] = CMD_SEND_LOGIN;
  p.set(hexToBytes(publicKeyHex), 1);
  p.set(pw, 33);
  return p;
}

// CMD_SEND_TXT_MSG: [2, txt_type, attempt, timestamp(4), pubkey_prefix(6), text]
// The timestamp is what the repeater's replay protection sees: it must never go
// backwards for this companion, and a resend with the SAME timestamp is treated
// as a retry (acknowledged again, not executed again). For CLI_DATA the
// companion overwrites it with its own clock.
export function textMessagePayload(publicKeyHex, text, { txtType = TXT_TYPE_PLAIN, attempt = 0, timestamp = 0 } = {}) {
  const t = new TextEncoder().encode(text);
  if (t.length > MAX_TEXT_LEN) throw new Error("Kommandoen er for lang til én pakke (" + t.length + " tegn, højst " + MAX_TEXT_LEN + ")");
  const p = new Uint8Array(13 + t.length);
  p[0] = CMD_SEND_TXT_MSG;
  p[1] = txtType;
  p[2] = attempt;
  new DataView(p.buffer).setUint32(3, timestamp, true);
  p.set(hexToBytes(publicKeyHex).slice(0, 6), 7);
  p.set(t, 13);
  return p;
}

// --- Node discovery ("repeaters nearby") ---------------------------------------
//
// The app's "repeaters nearby" is a zero-hop control packet: the companion
// transmits NODE_DISCOVER_REQ, the mesh never forwards it, and every repeater in
// direct RF range that has repeat on (and firmware new enough to know the
// packet) answers zero-hop with NODE_DISCOVER_RESP after a random delay:
// [0x90 | node_type, req_snr*4, tag(4), pubkey(32)]. Only the key and the
// signal come back - no name, no position (examples/simple_repeater
// onControlDataRecv, examples/companion_radio CMD_SEND_CONTROL_DATA).

// CMD_SEND_CONTROL_DATA carrying NODE_DISCOVER_REQ: [55, 0x80, filter, tag(4), since(4)]
// filter is a bit per ADV_TYPE (repeaters: 1 << 2); since 0 = everyone answers.
export function nodeDiscoverPayload(tag, { types = [ADV_TYPE_REPEATER], since = 0 } = {}) {
  const p = new Uint8Array(11);
  p[0] = CMD_SEND_CONTROL_DATA;
  p[1] = CTL_TYPE_NODE_DISCOVER_REQ; // low bit 0: full public keys in the answers
  p[2] = types.reduce((m, t) => m | (1 << t), 0);
  new DataView(p.buffer).setUint32(3, tag >>> 0, true);
  new DataView(p.buffer).setUint32(7, since, true);
  return p;
}

// PUSH_CODE_CONTROL_DATA: [0x8E, snr*4 (int8), rssi (int8), path_len, payload...]
export function parseControlData(p) {
  if (p[0] !== PUSH_CODE_CONTROL_DATA || p.length < 5) return null;
  return { snr: ((p[1] << 24) >> 24) / 4, rssi: (p[2] << 24) >> 24, pathLen: p[3], payload: p.slice(4) };
}

// A NODE_DISCOVER_RESP inside a control-data push, or null.
export function parseDiscoverResponse(p) {
  const c = parseControlData(p);
  if (!c || (c.payload[0] & 0xF0) !== CTL_TYPE_NODE_DISCOVER_RESP || c.payload.length < 6 + 32) return null;
  return {
    typeCode: c.payload[0] & 0x0F,
    type: ADV_TYPES[c.payload[0] & 0x0F] || String(c.payload[0] & 0x0F),
    reqSnr: ((c.payload[1] << 24) >> 24) / 4,    // how well the repeater heard the request
    tag: u32(c.payload, 2),
    publicKey: [...c.payload.slice(6, 38)].map(b => b.toString(16).padStart(2, "0")).join(""),
    snr: c.snr,                                   // how well the companion heard the answer
    rssi: c.rssi
  };
}

// CMD_ADD_UPDATE_CONTACT with the same layout as RESP_CODE_CONTACT: a contact known
// only by its key (no name, no path, no position), so that a login can be sent to it.
export function addContactPayload(publicKeyHex, { typeCode = ADV_TYPE_REPEATER, name = "" } = {}) {
  const p = new Uint8Array(1 + 32 + 3 + 64 + 32 + 4 + 4 + 4);
  p[0] = CMD_ADD_UPDATE_CONTACT;
  p.set(hexToBytes(publicKeyHex), 1);
  p[33] = typeCode;
  p[34] = 0;    // flags
  p[35] = 0xFF; // out_path_len: unknown -> flood
  new TextEncoder().encodeInto(name, p.subarray(100, 131));
  return p;
}

// CMD_SET_DEVICE_TIME: [6, epoch_seconds(4)]
export function setDeviceTimePayload(epochSeconds) {
  const p = new Uint8Array(5);
  p[0] = CMD_SET_DEVICE_TIME;
  new DataView(p.buffer).setUint32(1, epochSeconds, true);
  return p;
}

// The companion protocol over any frame transport. A subclass provides
// sendFrame(payload) and calls receiveFrame(payload) for every frame that
// arrives; this class provides the request/response logic on top. Frames are
// captured while a command is waiting for its answer; push frames (>= 0x80,
// e.g. login results and "message waiting") are also kept in an inbox so they
// can be awaited between commands.
export class CompanionLink {
  constructor({ onLog } = {}) {
    this.onLog = onLog || (() => {});
    this.encoder = new TextEncoder();
    this.connected = false;
    this.kind = "link";
    this.queue = [];
    this.capturing = false;
    this.pushes = [];
  }

  receiveFrame(frame) {
    this.onLog("rx", "[frame " + frame[0] + ", " + frame.length + " B] " + [...frame.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join(" ") + (frame.length > 16 ? " …" : ""));
    if (this.capturing) this.queue.push(frame);
    if (frame[0] >= 0x80) {
      this.pushes.push(frame);
      while (this.pushes.length > PUSH_INBOX_MAX) this.pushes.shift();
    }
  }
  beginFrameCapture() { this.queue = []; this.capturing = true; }
  capturedFrames() { return this.queue.slice(); }
  endFrameCapture() {
    this.capturing = false;
    const q = this.queue;
    this.queue = [];
    return q;
  }

  // Removes and returns the push frames matching `pred`.
  takePushes(pred) {
    const hits = this.pushes.filter(pred);
    this.pushes = this.pushes.filter(f => !pred(f));
    return hits;
  }

  // Waits up to timeoutMs for a push frame matching `pred`; returns it (removed
  // from the inbox) or null.
  async waitForPush(pred, timeoutMs) {
    const start = performance.now();
    while (true) {
      const hits = this.takePushes(pred);
      if (hits.length) return hits[0];
      if (!this.connected) return null;
      if (performance.now() - start >= timeoutMs) return null;
      await sleep(50);
    }
  }

  // Sends one companion frame and returns the payloads of the frames that come
  // back. With `expect` (a list of response codes) it waits for one of those;
  // otherwise for any frame. Then a short quiet period so a second frame is
  // not cut off. Unsolicited push frames (>= 0x80) never count as the answer.
  async companionCommand(payload, label, { timeoutMs = 1500, quietMs = 150, expect = null } = {}) {
    if (!this.connected) throw new Error("Ikke forbundet");
    this.onLog("tx", "<" + label + ">");
    this.beginFrameCapture();
    await this.sendFrame(payload);
    const start = performance.now();
    let lastCount = 0, lastChange = start;
    while (true) {
      await sleep(50);
      const now = performance.now();
      const frames = this.capturedFrames();
      if (frames.length !== lastCount) { lastCount = frames.length; lastChange = now; }
      const answered = frames.some(f => expect ? expect.includes(f[0]) : f[0] < 0x80);
      if (answered && now - lastChange >= quietMs) break;
      if (now - start >= timeoutMs) break;
    }
    const frames = this.endFrameCapture();
    for (const f of frames) this.onLog("info", "frame kode " + f[0] + " (" + f.length + " B)");
    return frames;
  }

  // Sets the companion's clock, as the app does on connect. The firmware only
  // moves it forwards: false when its clock is already ahead of ours.
  async companionSetTime(epochSeconds = Math.floor(Date.now() / 1000)) {
    const frames = await this.companionCommand(setDeviceTimePayload(epochSeconds), "CMD_SET_DEVICE_TIME " + epochSeconds, { expect: [RESP_CODE_OK, RESP_CODE_ERR] });
    return frames.some(f => f[0] === RESP_CODE_OK);
  }

  // The companion's clock (epoch seconds), or null if it did not answer.
  async companionGetTime() {
    const frames = await this.companionCommand(Uint8Array.from([CMD_GET_DEVICE_TIME]), "CMD_GET_DEVICE_TIME", { expect: [RESP_CODE_CURR_TIME, RESP_CODE_ERR] });
    const t = frames.map(parseCurrTime).find(v => v !== null && v !== undefined);
    return t === undefined ? null : t;
  }

  // "Repeaters nearby": sends NODE_DISCOVER_REQ and listens for windowMs.
  // Returns { supported, found } where found is one entry per repeater that
  // answered (best signal kept if it answered twice), sorted by the companion's
  // SNR. supported is false when the companion firmware does not know the
  // command (protocol v8+), null when it did not answer at all.
  async companionDiscover({ windowMs = 10000, types = [ADV_TYPE_REPEATER], onFound = null } = {}) {
    const tag = crypto.getRandomValues(new Uint32Array(1))[0];
    this.takePushes(f => f[0] === PUSH_CODE_CONTROL_DATA);
    const frames = await this.companionCommand(nodeDiscoverPayload(tag, { types }), "CMD_SEND_CONTROL_DATA NODE_DISCOVER_REQ", { expect: [RESP_CODE_OK, RESP_CODE_ERR] });
    if (frames.some(f => f[0] === RESP_CODE_ERR)) return { supported: false, found: [] };
    if (!frames.some(f => f[0] === RESP_CODE_OK)) return { supported: null, found: [] };
    const found = new Map();
    const deadline = performance.now() + windowMs;
    while (performance.now() < deadline) {
      const push = await this.waitForPush(f => f[0] === PUSH_CODE_CONTROL_DATA, deadline - performance.now());
      if (!push) break;
      const r = parseDiscoverResponse(push);
      if (!r || r.tag !== tag) continue;
      this.onLog("info", "discovery: " + r.type + " " + r.publicKey.slice(0, 12) + "… svarede (SNR " + r.snr + " dB her, " + r.reqSnr + " dB hos den)");
      const prev = found.get(r.publicKey);
      if (!prev || r.snr > prev.snr) found.set(r.publicKey, r);
      if (onFound) onFound(r, found.size);
    }
    return { supported: true, found: [...found.values()].sort((a, b) => b.snr - a.snr) };
  }

  // Adds (or updates) a contact known only by its public key; true on OK.
  async companionAddContact(publicKeyHex, opts = {}) {
    const frames = await this.companionCommand(addContactPayload(publicKeyHex, opts), "CMD_ADD_UPDATE_CONTACT " + publicKeyHex.slice(0, 12), { expect: [RESP_CODE_OK, RESP_CODE_ERR] });
    const err = frames.find(f => f[0] === RESP_CODE_ERR);
    if (err) this.onLog("error", "kontakt kunne ikke tilføjes: " + (ERR_CODES[err[1]] || "fejlkode " + err[1]));
    return frames.some(f => f[0] === RESP_CODE_OK);
  }

  // Pulls one message from the companion's queue. Returns
  //   { kind: "contact", message }  - a message from a contact (parseContactMessage)
  //   { kind: "channel", frame }    - a channel (group) message
  //   { kind: "empty" }             - the queue is empty
  //   { kind: "none" }              - nothing answered
  async companionNextMessage() {
    const frames = await this.companionCommand(Uint8Array.from([CMD_SYNC_NEXT_MESSAGE]), "CMD_SYNC_NEXT_MESSAGE",
      { expect: [RESP_CODE_CONTACT_MSG_RECV, RESP_CODE_CONTACT_MSG_RECV_V3, RESP_CODE_CHANNEL_MSG_RECV, RESP_CODE_CHANNEL_MSG_RECV_V3, RESP_CODE_NO_MORE_MESSAGES, RESP_CODE_ERR], timeoutMs: 3000, quietMs: 50 });
    for (const f of frames) {
      if (f[0] === RESP_CODE_CONTACT_MSG_RECV || f[0] === RESP_CODE_CONTACT_MSG_RECV_V3) return { kind: "contact", message: parseContactMessage(f) };
      if (f[0] === RESP_CODE_CHANNEL_MSG_RECV || f[0] === RESP_CODE_CHANNEL_MSG_RECV_V3) return { kind: "channel", frame: f };
      if (f[0] === RESP_CODE_NO_MORE_MESSAGES) return { kind: "empty" };
    }
    return { kind: "none" };
  }

  // The companion's contact list (everything it has heard an advert from).
  // The firmware streams one RESP_CODE_CONTACT per main-loop pass, so this
  // waits for RESP_CODE_END_OF_CONTACTS with a generous timeout.
  async companionGetContacts({ timeoutMs = 30000 } = {}) {
    const frames = await this.companionCommand(Uint8Array.from([CMD_GET_CONTACTS]), "CMD_GET_CONTACTS", { expect: [RESP_CODE_END_OF_CONTACTS, RESP_CODE_ERR], timeoutMs, quietMs: 100 });
    const err = frames.find(f => f[0] === RESP_CODE_ERR);
    if (err) throw new Error("Kunne ikke hente kontakter: " + (ERR_CODES[err[1]] || "fejlkode " + err[1]));
    const complete = frames.some(f => f[0] === RESP_CODE_END_OF_CONTACTS);
    return { contacts: frames.map(parseContact).filter(Boolean), complete };
  }

  // Sends the companion app's two hello frames. Returns { deviceInfo, selfInfo }
  // (either may be null) or null if nothing frame-shaped answered.
  async companionQuery() {
    const a = await this.companionCommand(Uint8Array.from([CMD_DEVICE_QUERY, 1]), "CMD_DEVICE_QUERY", { expect: [RESP_CODE_DEVICE_INFO] });
    const b = await this.companionCommand(Uint8Array.from([CMD_APP_START, 0, 0, 0, 0, 0, 0, 0, ...this.encoder.encode("meshguide")]), "CMD_APP_START meshguide", { expect: [RESP_CODE_SELF_INFO] });
    const frames = [...a, ...b];
    const dev = frames.map(parseDeviceInfo).find(Boolean) || null;
    const self = frames.map(parseSelfInfo).find(Boolean) || null;
    return dev || self ? { deviceInfo: dev, selfInfo: self } : null;
  }

  // { name, key } of the companion's default flood scope; name null when unset;
  // null when the firmware did not answer (too old for the command).
  async companionGetDefaultScope() {
    const frames = await this.companionCommand(Uint8Array.from([CMD_GET_DEFAULT_FLOOD_SCOPE]), "CMD_GET_DEFAULT_FLOOD_SCOPE", { expect: [RESP_CODE_DEFAULT_FLOOD_SCOPE] });
    return frames.map(parseDefaultScope).find(Boolean) || null;
  }

  // The auto-add settings ({ config, maxHops }), or null on firmware without the command.
  async companionGetAutoAdd() {
    const frames = await this.companionCommand(Uint8Array.from([CMD_GET_AUTOADD_CONFIG]), "CMD_GET_AUTOADD_CONFIG", { expect: [RESP_CODE_AUTOADD_CONFIG, RESP_CODE_ERR] });
    return frames.map(parseAutoAddConfig).find(Boolean) || null;
  }

  // Renames the companion (its advert name); true on RESP_CODE_OK.
  async companionSetName(name) {
    return this.companionSet(setAdvertNamePayload(name), "CMD_SET_ADVERT_NAME " + name);
  }

  // Sends a companion write command; true on RESP_CODE_OK.
  async companionSet(payload, label) {
    const frames = await this.companionCommand(payload, label, { expect: [RESP_CODE_OK, RESP_CODE_ERR] });
    const err = frames.find(f => f[0] === RESP_CODE_ERR);
    if (err) this.onLog("error", label + ": fejlkode " + err[1]);
    return frames.some(f => f[0] === RESP_CODE_OK && f.length === 1);
  }
}

export class MeshCoreSerial extends CompanionLink {
  constructor(opts = {}) {
    super(opts);
    this.kind = "usb";
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = "";
    this.pending = null;
    this.frameMode = false;            // true while talking companion protocol: bytes are frames, not text
    this.frameBuf = new Uint8Array(0); // incomplete frame tail
  }

  // Switches between the text CLI (repeater) and companion frames on the same port.
  setFrameMode(on) {
    this.frameMode = on;
    this.frameBuf = new Uint8Array(0);
    if (!on) this.buffer = "";
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
          if (this.frameMode) {
            const { frames, rest } = extractFrames(concat([this.frameBuf, value]));
            this.frameBuf = rest;
            for (const f of frames) this.receiveFrame(f);
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

  // --- companion frames over the serial port ('<' + len16 + payload out, '>' + len16 + payload in) ---
  async sendFrame(payload) {
    if (!this.frameMode) this.setFrameMode(true);
    await this.writer.write(companionFrame(payload));
  }

  // Works out what is on the other end:
  //   { kind: "cli", version, role }              - repeater / room server / sensor firmware (text CLI)
  //   { kind: "companion", deviceInfo, selfInfo } - companion firmware (binary protocol)
  //   { kind: "unknown" }                         - nothing answered
  // Text is probed first: a repeater would keep a binary frame in its line
  // buffer, so the binary probe only runs when the text CLI is silent, and a
  // bare "\r" flushes the buffer afterwards. After a companion answers, the
  // port stays in frame mode.
  async identify() {
    await this.command("", { timeoutMs: 600 }); // flush any half-typed line on the device
    const ver = await this.command("ver", { timeoutMs: 1500 });
    if (ver.reply && /\d+\.\d+/.test(ver.reply)) {
      const role = await this.command("get role", { timeoutMs: 1500 });
      return { kind: "cli", version: ver.reply, role: role.value };
    }
    this.setFrameMode(true);
    const companion = await this.companionQuery();
    if (companion) return { kind: "companion", ...companion };
    this.setFrameMode(false);
    await this.command("", { timeoutMs: 600 });
    return { kind: "unknown" };
  }
}
