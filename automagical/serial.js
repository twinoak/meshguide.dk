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

const QUIET_MS = 200;        // silence after a "-> " reply line = reply complete
const NO_REPLY_MS = 800;     // silence after only the echo = command gave no reply
const DEFAULT_TIMEOUT_MS = 2500;
const REPLY_PREFIX = "-> ";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function serialSupported() {
  return typeof navigator !== "undefined" && !!navigator.serial;
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
}
