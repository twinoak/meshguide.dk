// contacts-ui.js - the "pick the repeater" table of the over-the-mesh route.
//
// Two sources feed it: "repeaters nearby" (a zero-hop discovery: only repeaters
// in direct RF range answer, with signal but without name or position) and the
// companion's contact list (everything it has ever heard an advert from, any
// number of hops away). The table shows the nearby ones by default - that is
// almost always the repeater the user is standing next to - and the whole
// contact list behind "Vis alle kontakter". Names for discovered keys come from
// the contact list; unknown keys get a nameless row and are added to the
// companion as a contact when the user logs in to them (a login needs one).

import { escapeHtml, setProgress, showError } from "./flow.js";

const TYPE_LABELS = { repeater: "Repeater", room: "Room server", sensor: "Sensor", companion: "Companion" };
// A repeater answers a discovery after a random delay of up to 20 x its airtime x
// its txdelay factor (simple_repeater: getRetransmitDelay() x 4): about 4-5 s at
// the default txdelay 0.5, but up to ~18 s for a hilltop repeater on txdelay 2.0.
// The window is sized for the latter.
export const DISCOVER_WINDOW_MS = 20000;

export function ago(epochSeconds) {
  if (!epochSeconds) return "–";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (s < 90) return s + " s siden";
  if (s < 5400) return Math.round(s / 60) + " min siden";
  if (s < 172800) return Math.round(s / 3600) + " t siden";
  return Math.round(s / 86400) + " d siden";
}

export function pathText(c) {
  if (c.outPathLen < 0) return "ukendt (flood)";
  if (c.outPathLen === 0) return "direkte";
  return c.outPathLen + " hop";
}

// A progress bar that runs down: `left` of `total` ms remain.
function setCountdown(el, left, total, text) {
  el.hidden = false;
  el.querySelector(".am-bar").classList.remove("indeterminate");
  el.querySelector(".am-bar-fill").style.width = Math.round(100 * left / total) + "%";
  el.querySelector(".text").textContent = text;
}

// ui: { contactTable, contactsText, contactsError, contactsProgress, btnContacts, btnDiscover, btnShowAll, discoverText }
// getLink(): the companion link. onSelect(contact): called when a row is picked.
export function createContactPicker({ ui, log, getLink, onSelect }) {
  const state = {
    contacts: [],      // repeaters and room servers, in display order
    nearby: new Map(), // publicKey -> discovery result
    selected: null,
    showAll: false,    // false: only the nearby ones are listed
    loaded: false,     // the contact list has been fetched
    discovered: false  // a discovery has run at least once
  };

  function sortContacts() {
    state.contacts.sort((a, b) => {
      const na = state.nearby.get(a.publicKey), nb = state.nearby.get(b.publicKey);
      if (na && nb) return nb.snr - na.snr;
      if (na || nb) return na ? -1 : 1;
      return b.lastAdvert - a.lastAdvert;
    });
  }

  async function load() {
    const link = getLink();
    if (!link) return;
    showError(ui.contactsError, "");
    ui.btnContacts.disabled = true;
    ui.btnDiscover.disabled = true;
    ui.contactsText.textContent = "";
    setProgress(ui.contactsProgress, { text: "Henter kontaktlisten fra companionen …" });
    let result;
    try {
      result = await link.companionGetContacts();
    } catch (e) {
      setProgress(ui.contactsProgress, null);
      ui.btnContacts.disabled = false;
      ui.btnDiscover.disabled = false;
      showError(ui.contactsError, "Kunne ikke hente kontakter: " + (e && e.message ? e.message : e));
      return;
    }
    setProgress(ui.contactsProgress, null);
    ui.btnContacts.disabled = false;
    ui.btnDiscover.disabled = false;
    state.loaded = true;
    const all = result.contacts;
    const listed = all.filter(c => c.type === "repeater" || c.type === "room");
    // Keep rows that only discovery knows about.
    const known = new Set(listed.map(c => c.publicKey));
    for (const c of state.contacts) if (c.discovered && !known.has(c.publicKey)) listed.push(c);
    state.contacts = listed;
    sortContacts();
    const shown = listed.filter(c => !c.discovered).length;
    const hidden = all.length - shown;
    ui.contactsText.textContent = (shown ? shown + " repeatere/room servers i kontaktlisten" : "Ingen repeatere eller room servers i kontaktlisten - vent på en advert og hent listen igen")
      + (hidden ? " (" + hidden + " andre kontakter vises ikke)" : "") + (result.complete ? "" : " - listen blev afbrudt, hent den igen");
    render();
    reselect();
  }

  function setShowAll(on) {
    state.showAll = on;
    render();
  }

  // "Repeaters nearby": merges the answers into the table.
  async function discover() {
    const link = getLink();
    if (!link) return;
    showError(ui.contactsError, "");
    ui.btnDiscover.disabled = true;
    ui.btnContacts.disabled = true;
    ui.discoverText.textContent = "";
    // Countdown while listening: the bar empties, the text counts the seconds and the answers.
    const started = performance.now();
    let answers = 0;
    const tick = () => {
      const left = Math.max(0, DISCOVER_WINDOW_MS - (performance.now() - started));
      setCountdown(ui.contactsProgress, left, DISCOVER_WINDOW_MS, "Lytter efter repeatere i nærheden … " + Math.ceil(left / 1000) + " s" + (answers ? " · " + answers + " svar" : ""));
    };
    tick();
    const timer = setInterval(tick, 250);
    let result;
    try {
      result = await link.companionDiscover({ windowMs: DISCOVER_WINDOW_MS, onFound: (r, n) => { answers = n; tick(); } });
    } catch (e) {
      result = { supported: null, found: [], error: e && e.message ? e.message : String(e) };
    }
    clearInterval(timer);
    setProgress(ui.contactsProgress, null);
    ui.btnDiscover.disabled = false;
    ui.btnContacts.disabled = false;
    state.discovered = true;
    if (result.supported === false) {
      ui.discoverText.textContent = "Companionens firmware kender ikke discovery-kommandoen (kræver nyere firmware) - brug kontaktlisten.";
      return;
    }
    if (result.supported === null) {
      ui.discoverText.textContent = "Companionen svarede ikke på discovery" + (result.error ? " (" + result.error + ")" : "") + " - prøv igen.";
      return;
    }
    let added = 0, matched = 0;
    for (const r of result.found) {
      state.nearby.set(r.publicKey, r);
      const existing = state.contacts.find(c => c.publicKey === r.publicKey);
      if (existing) { matched++; continue; }
      state.contacts.push({ publicKey: r.publicKey, name: "", type: r.type, typeCode: r.typeCode, lastAdvert: 0, lat: 0, lon: 0, outPathLen: -1, outPathHashSize: null, discovered: true });
      added++;
    }
    sortContacts();
    ui.discoverText.textContent = result.found.length
      ? result.found.length + " repeater" + (result.found.length === 1 ? "" : "e") + " svarede inden for direkte rækkevidde" + (matched ? " (" + matched + " kendt" + (matched === 1 ? "" : "e") + " fra kontaktlisten)" : "") + (added ? " - " + added + " uden navn, tilføjes som kontakt ved login" : "") + "."
      : "Ingen repeatere svarede inden for " + Math.round(DISCOVER_WINDOW_MS / 1000) + " s. Kun repeatere i direkte rækkevidde svarer, og kun hvis de har repeat slået til og firmware der kender discovery. En repeater svarer desuden højst 4 gange på 2 minutter - har du søgt flere gange lige efter hinanden, så vent lidt og søg igen. Står din længere væk, så vis alle kontakter.";
    log("info", "discovery: " + result.found.length + " svar");
    render();
    reselect();
  }

  function nearbyText(c) {
    const n = state.nearby.get(c.publicKey);
    if (!n) return '<span class="muted">–</span>';
    return "SNR " + n.snr + " dB her · " + n.reqSnr + " dB hos den";
  }

  function visibleContacts() {
    return state.showAll ? state.contacts : state.contacts.filter(c => state.nearby.has(c.publicKey));
  }

  function render() {
    const total = state.contacts.filter(c => !c.discovered).length;
    ui.btnShowAll.textContent = state.showAll ? "Vis kun dem i nærheden" : "Vis alle kontakter (" + total + ")";
    ui.btnShowAll.hidden = !state.loaded;
    ui.btnContacts.hidden = !state.showAll;
    const rows = visibleContacts();
    ui.contactTable.innerHTML = rows.map(c => {
      const i = state.contacts.indexOf(c);
      const sel = state.selected && state.selected.publicKey === c.publicKey;
      const name = c.name ? escapeHtml(c.name) : (c.discovered ? '<span class="muted">(intet navn endnu - kun hørt via discovery)</span>' : "(uden navn)");
      return `<tr class="${sel ? "selected" : ""}${state.nearby.has(c.publicKey) ? " nearby" : ""}" data-i="${i}">`
        + `<td><input type="radio" name="contact" value="${i}" ${sel ? "checked" : ""} aria-label="Vælg ${escapeHtml(c.name || c.publicKey.slice(0, 12))}"></td>`
        + `<td class="name">${name}</td>`
        + `<td>${TYPE_LABELS[c.type] || escapeHtml(c.type)}</td>`
        + `<td>${ago(c.lastAdvert)}</td>`
        + `<td>${pathText(c)}</td>`
        + `<td class="nearby">${nearbyText(c)}</td>`
        + `<td>${c.lat || c.lon ? c.lat.toFixed(4) + ", " + c.lon.toFixed(4) : '<span class="muted">–</span>'}</td>`
        + `<td><code>${c.publicKey.slice(0, 12)}…</code></td></tr>`;
    }).join("");
    for (const tr of ui.contactTable.querySelectorAll("tr")) {
      tr.addEventListener("click", () => select(state.contacts[Number(tr.dataset.i)]));
    }
    ui.contactTable.parentElement.hidden = rows.length === 0; // no header over an empty table
    ui.contactsText.hidden = !state.showAll;
  }

  function reselect() {
    if (!state.selected) return;
    const still = state.contacts.find(c => c.publicKey === state.selected.publicKey);
    if (still) select(still); else { state.selected = null; onSelect(null); }
  }

  function select(c) {
    state.selected = c;
    for (const tr of ui.contactTable.querySelectorAll("tr")) {
      const mine = state.contacts[Number(tr.dataset.i)].publicKey === c.publicKey;
      tr.classList.toggle("selected", mine);
      tr.querySelector("input").checked = mine;
    }
    onSelect(c);
  }

  // A contact that only discovery knows about has to exist in the companion
  // before a login can be sent to it.
  async function ensureContact(c) {
    if (!c.discovered) return true;
    const link = getLink();
    const ok = await link.companionAddContact(c.publicKey, { typeCode: c.typeCode });
    if (ok) c.discovered = false;
    return ok;
  }

  function reset() {
    state.contacts = [];
    state.nearby = new Map();
    state.selected = null;
    state.showAll = false;
    state.loaded = false;
    state.discovered = false;
    ui.contactTable.innerHTML = "";
    ui.contactTable.parentElement.hidden = false;
    ui.contactsText.textContent = "";
    ui.discoverText.textContent = "";
    ui.btnShowAll.hidden = true;
    ui.btnContacts.hidden = true;
  }

  // On connect: the contact list first (names), then a discovery.
  async function start() {
    await load();
    await discover();
  }

  ui.btnContacts.addEventListener("click", load);
  ui.btnDiscover.addEventListener("click", discover);
  ui.btnShowAll.addEventListener("click", () => setShowAll(!state.showAll));

  return { state, start, load, discover, select, ensureContact, reset, setShowAll };
}
