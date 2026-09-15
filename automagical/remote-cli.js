// remote-cli.js - runs a repeater's CLI over the mesh, through a companion.
//
// This is what the MeshCore app calls remote management. The companion (USB or
// Bluetooth, see serial.js / ble.js) has the repeater in its contact list; we
// log in with the repeater's admin password (CMD_SEND_LOGIN -> push
// PUSH_CODE_LOGIN_SUCCESS/FAIL) and then send each CLI line as a text message
// (CMD_SEND_TXT_MSG). The repeater runs it through the same handleCommand() as
// its serial console - but only for clients logged in as admin
// (examples/simple_repeater/main.cpp, onPeerDataRecv) - and sends the reply
// back as a CLI_DATA message, which the companion queues and announces with
// PUSH_CODE_MSG_WAITING; CMD_SYNC_NEXT_MESSAGE fetches it.
//
// Matching replies to commands is the whole difficulty: a reply carries no
// hint of which command it answers, the companion's queue is first-in
// first-out, and anything left in it from earlier (a late reply, a re-executed
// retry, a chat message) shifts every later answer by one. The rules here:
//
// 1. Commands are sent as TXT_TYPE_PLAIN with OUR timestamp. The repeater
//    treats a resend with the same timestamp as a retry: it acknowledges again
//    but does not execute again, so a retry can never produce a second reply.
//    (With TXT_TYPE_CLI_DATA the companion stamps every send with its own clock
//    and every retry is executed and answered anew.) The timestamp must not go
//    backwards for this companion, so it is based on the later of our clock and
//    the companion's.
// 2. PLAIN messages are acknowledged (PUSH_CODE_SEND_CONFIRMED), so we know
//    whether a command reached the repeater. No ack and no reply -> resend
//    (same timestamp). Ack but no reply -> it ran, the reply is late or lost;
//    a resend cannot help, so wait one more window and give up.
// 3. Before every send the companion's queue is emptied: anything from the
//    repeater in it is an old reply and is discarded (counted in stats.stale).
//    Other messages (chat) are logged; they cannot be put back.
// 4. Everything is bounded: ATTEMPTS sends, a fixed wait per window (the
//    companion's own round-trip estimate plus a margin, clamped), then the
//    command is given up and the caller carries on.
//
// Sizes line up with the serial CLI: a command must fit in one packet (160
// chars), the reply in one packet (~160 chars) - the same cap the CLI applies
// to "region list".

import {
  RESP_CODE_ERR, RESP_CODE_SENT, PUSH_CODE_SEND_CONFIRMED, PUSH_CODE_MSG_WAITING, PUSH_CODE_LOGIN_SUCCESS, PUSH_CODE_LOGIN_FAIL,
  TXT_TYPE_PLAIN, TXT_TYPE_CLI_DATA, ERR_CODES, loginPayload, textMessagePayload, parseSent, parseAck, parseReply
} from "./serial.js";

export const ATTEMPTS = 3;
const MIN_WAIT_MS = 5000;      // never wait less than this for a reply, whatever the companion estimates
const MAX_WAIT_MS = 20000;     // ... and never more than this per window
const MARGIN_MS = 3000;        // added to the companion's own round-trip estimate
const FRAME_TIMEOUT_MS = 3000; // for the companion's immediate RESP_CODE_SENT / ERR
const DRAIN_MAX = 50;          // messages pulled from the queue per drain, at most

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function prefixOf(publicKeyHex) {
  return publicKeyHex.slice(0, 12);
}

function pushPrefix(frame) {
  return [...frame.slice(2, 8)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Same shape as MeshCoreSerial.command(): { cmd, reply, value, ok, unsupported }.
export class RemoteCli {
  constructor(link, contact, { onLog, attempts = ATTEMPTS } = {}) {
    this.link = link;
    this.contact = contact;
    this.prefix = prefixOf(contact.publicKey);
    this.onLog = onLog || (() => {});
    this.attempts = attempts;
    this.kind = "remote";
    this.loggedIn = false;
    this.isAdmin = false;
    this.clockOffset = 0;  // seconds the companion's clock is ahead of ours (never negative)
    this.lastTimestamp = 0;
    this.stats = { sent: 0, replies: 0, retries: 0, failed: 0, stale: 0, acks: 0 };
  }

  get connected() { return this.link.connected && this.loggedIn; }

  // A timestamp the repeater will accept: never earlier than the companion's
  // clock (its CLI_DATA sends used that), never repeating.
  nextTimestamp() {
    const now = Math.floor(Date.now() / 1000) + this.clockOffset;
    const t = Math.max(now, this.lastTimestamp + 1);
    this.lastTimestamp = t;
    return t;
  }

  // Logs in to the repeater. Returns { ok, isAdmin, reason } where reason is
  // "password" (the repeater said no), "timeout" (no answer) or an error text.
  async login(password) {
    const companionTime = await this.link.companionGetTime();
    if (companionTime !== null) {
      this.clockOffset = Math.max(0, companionTime - Math.floor(Date.now() / 1000));
      if (this.clockOffset > 0) this.onLog("info", "companionens ur er " + this.clockOffset + " s foran - kommandoer stemples efter det");
    }
    let reason = "timeout";
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      this.link.takePushes(f => f[0] === PUSH_CODE_LOGIN_SUCCESS || f[0] === PUSH_CODE_LOGIN_FAIL);
      const frames = await this.link.companionCommand(loginPayload(this.contact.publicKey, password), "CMD_SEND_LOGIN " + this.contact.name, { expect: [RESP_CODE_SENT, RESP_CODE_ERR], timeoutMs: FRAME_TIMEOUT_MS });
      const err = frames.find(f => f[0] === RESP_CODE_ERR);
      if (err) return { ok: false, isAdmin: false, reason: ERR_CODES[err[1]] || "fejlkode " + err[1] };
      const sent = frames.map(parseSent).find(Boolean);
      if (!sent) { reason = "companionen svarede ikke"; continue; }
      const wait = this.windowFor(sent, MAX_WAIT_MS);
      this.onLog("info", "login sendt" + (sent.flood ? " (flood)" : " (direkte)") + ", venter op til " + Math.round(wait / 1000) + " s …");
      const push = await this.link.waitForPush(f => (f[0] === PUSH_CODE_LOGIN_SUCCESS || f[0] === PUSH_CODE_LOGIN_FAIL) && pushPrefix(f) === this.prefix, wait);
      if (!push) { this.onLog("info", "intet svar på login (forsøg " + attempt + "/" + this.attempts + ")"); continue; }
      if (push[0] === PUSH_CODE_LOGIN_FAIL) return { ok: false, isAdmin: false, reason: "password" };
      this.loggedIn = true;
      this.isAdmin = push[1] === 1;
      if (this.isAdmin) await this.drain(); // start with an empty queue (a guest cannot run commands anyway)
      return { ok: true, isAdmin: this.isAdmin, reason: null };
    }
    return { ok: false, isAdmin: false, reason };
  }

  windowFor(sent, timeoutMs) {
    return Math.min(Math.max(sent.estTimeoutMs + MARGIN_MS, MIN_WAIT_MS), timeoutMs);
  }

  // Empties the companion's message queue. Old replies from our repeater are
  // discarded and counted; anything else is logged.
  async drain() {
    for (let i = 0; i < DRAIN_MAX; i++) {
      const next = await this.link.companionNextMessage();
      if (next.kind === "empty" || next.kind === "none") return;
      this.logForeign(next, "smidt væk");
    }
  }

  logForeign(next, what) {
    if (next.kind === "contact" && next.message) {
      const m = next.message;
      if (m.prefix === this.prefix && m.txtType === TXT_TYPE_CLI_DATA) {
        this.stats.stale++;
        this.onLog("info", "gammelt CLI-svar fra " + this.contact.name + " lå i companionens kø (" + what + "): " + m.text);
      } else {
        this.onLog("info", "besked fra " + m.prefix + " (type " + m.txtType + ") hentet fra companionens kø (" + what + "): " + m.text);
      }
    } else if (next.kind === "channel") {
      this.onLog("info", "kanalbesked hentet fra companionens kø (" + what + ", " + next.frame.length + " B)");
    }
  }

  // Sends one CLI line and returns the parsed reply; { ok: false, reply: null }
  // when it is given up.
  async command(cmd, { timeoutMs = MAX_WAIT_MS, attempts = this.attempts } = {}) {
    if (!this.link.connected) throw new Error("Ikke forbundet");
    if (!this.loggedIn) throw new Error("Ikke logget ind på " + this.contact.name);
    const timestamp = this.nextTimestamp();
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) this.stats.retries++;
      this.onLog("tx", cmd + (attempt > 1 ? "  (forsøg " + attempt + "/" + attempts + ", samme tidsstempel)" : ""));
      await this.drain();
      this.link.takePushes(f => f[0] === PUSH_CODE_MSG_WAITING || f[0] === PUSH_CODE_SEND_CONFIRMED);
      const payload = textMessagePayload(this.contact.publicKey, cmd, { txtType: TXT_TYPE_PLAIN, attempt: attempt - 1, timestamp });
      const frames = await this.link.companionCommand(payload, "CMD_SEND_TXT_MSG → " + this.contact.name, { expect: [RESP_CODE_SENT, RESP_CODE_ERR], timeoutMs: FRAME_TIMEOUT_MS });
      const err = frames.find(f => f[0] === RESP_CODE_ERR);
      if (err) {
        this.stats.failed++;
        this.onLog("error", cmd + ": companionen afviste (" + (ERR_CODES[err[1]] || "fejlkode " + err[1]) + ")");
        return { cmd, lines: [], reply: null, value: null, ok: false, unsupported: false, error: ERR_CODES[err[1]] || "fejlkode " + err[1] };
      }
      const sent = frames.map(parseSent).find(Boolean);
      if (!sent) { this.onLog("info", "companionen svarede ikke på afsendelsen"); continue; }
      this.stats.sent++;
      const wait = this.windowFor(sent, timeoutMs);
      let got = await this.awaitReply(wait, sent.ack);
      if (got.text === null && got.acked) {
        // The repeater has it (and ran it); a resend would only be acknowledged again.
        this.onLog("info", "\"" + cmd + "\" nåede frem (kvitteret efter " + got.tripMs + " ms), men svaret er ikke kommet - venter " + Math.round(wait / 1000) + " s mere");
        got = await this.awaitReply(wait, sent.ack);
        if (got.text === null) break;
      }
      if (got.text === null) { this.onLog("info", "intet svar på \"" + cmd + "\" inden " + Math.round(wait / 1000) + " s (forsøg " + attempt + "/" + attempts + ")"); continue; }
      this.stats.replies++;
      this.onLog("rx", got.text);
      const [first, ...rest] = got.text.split("\n");
      return parseReply(cmd, ["  -> " + first, ...rest]);
    }
    this.stats.failed++;
    this.onLog("error", "\"" + cmd + "\" opgivet");
    return { cmd, lines: [], reply: null, value: null, ok: false, unsupported: false, timedOut: true };
  }

  // Waits up to waitMs for the repeater's CLI reply (a CLI_DATA message from our
  // contact) while noting the acknowledgement for `ack`. Returns { text, acked, tripMs }.
  async awaitReply(waitMs, ack) {
    const deadline = performance.now() + waitMs;
    let acked = false, tripMs = null;
    while (performance.now() < deadline) {
      const push = await this.link.waitForPush(f => f[0] === PUSH_CODE_MSG_WAITING || (f[0] === PUSH_CODE_SEND_CONFIRMED && parseAck(f) && parseAck(f).ack === ack), deadline - performance.now());
      if (!push) break;
      if (push[0] === PUSH_CODE_SEND_CONFIRMED) {
        acked = true;
        tripMs = parseAck(push).tripMs;
        this.stats.acks++;
        continue;
      }
      for (let i = 0; i < DRAIN_MAX; i++) {
        const next = await this.link.companionNextMessage();
        if (next.kind === "empty" || next.kind === "none") break;
        const m = next.kind === "contact" ? next.message : null;
        if (m && m.prefix === this.prefix && m.txtType === TXT_TYPE_CLI_DATA) return { text: m.text, acked, tripMs };
        this.logForeign(next, "under ventetiden");
      }
      await sleep(50);
    }
    return { text: null, acked, tripMs };
  }

  async disconnect() {
    this.loggedIn = false;
  }
}
