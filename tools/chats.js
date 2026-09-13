// chats.js - the chat registry, derived from cities.json and the postal codes.
//
// Build-time only (imported by build-api.js); the browser never needs this.
// Chats come from two sources:
//
// - the hand-curated city chats in cities.json (#horsens, #dk-fyn, ...).
// - one derived chat per postal-code scope. Each postal code is expanded into
//   its prefix layers using the same layer convention as scopes.js (dk5230 ->
//   dk5, dk52, dk523, dk5230), so the aggregate rooms (e.g. #dk50, covering all
//   of 50xx) are included too. Each chat has scope = key, handle #<key> and a
//   centroid Point as its location (bbox center of the postal code; for an
//   aggregate layer the center of ALL its postal codes). On a key collision
//   with a curated city chat, the city chat wins.

import { geomBBox, postalLayers } from "../scopes.js";

const POSTAL_KEY = /^dk(\d{4})$/;

// Rounds to 4 decimals the way PHP's round($x, 4) does: decimal ties (which
// are common here, since the centroid is the mean of two 4-decimal numbers)
// round half away from zero, regardless of how the double happens to fall.
function round4(x) {
  const y = Number((Math.abs(x) * 1e4).toFixed(6));
  return Math.sign(x) * Math.round(y) / 1e4;
}

// Flat entry -> key-tagged object, so a consumer knows the chat's id.
export function chatEntry(key, v) {
  return { key, ...v };
}

// key -> chat, sorted by key.
export function postalChats(postnumreFiles) {
  const bb = {};
  const seenLeaf = new Set();
  for (const file of postnumreFiles) {
    if (!file || typeof file !== "object") continue;
    for (const [k, v] of Object.entries(file)) {
      const m = POSTAL_KEY.exec(k);
      if (!m) continue;
      if (seenLeaf.has(k)) continue; // first file wins (like scopes.js)
      seenLeaf.add(k);
      const box = v && v.geometry ? geomBBox(v.geometry) : null;
      if (!box || !Number.isFinite(box[0])) continue;
      for (const sk of postalLayers(m[1])) {
        if (!bb[sk]) {
          bb[sk] = [...box];
        } else {
          if (box[0] < bb[sk][0]) bb[sk][0] = box[0];
          if (box[1] < bb[sk][1]) bb[sk][1] = box[1];
          if (box[2] > bb[sk][2]) bb[sk][2] = box[2];
          if (box[3] > bb[sk][3]) bb[sk][3] = box[3];
        }
      }
    }
  }
  const out = {};
  for (const k of Object.keys(bb).sort()) {
    const box = bb[k];
    out[k] = {
      key: k,
      name: k,
      scope: k,
      localChat: "#" + k,
      geometry: {
        type: "Point",
        coordinates: [round4((box[0] + box[2]) / 2), round4((box[1] + box[3]) / 2)]
      }
    };
  }
  return out;
}

// The whole registry as a list: city chats first (hand-curated, in cities.json
// order), then one chat per postal-code scope that does not collide with a
// city key. Each element carries its own key.
export function allChats(cities, postnumreFiles) {
  const out = [];
  const seen = new Set();
  for (const [k, v] of Object.entries(cities)) {
    out.push(chatEntry(k, v));
    seen.add(k);
  }
  for (const entry of Object.values(postalChats(postnumreFiles))) {
    if (seen.has(entry.key)) continue;
    out.push(entry);
  }
  return out;
}

// alias -> chat, for the per-chat lookup files. A city chat is reachable by
// its key ("odense"), its handle ("#dk-fyn-odense", with or without #) and its
// name ("Odense"), all lowercased. A postal chat is reachable by its key
// ("dk5000") and its bare digits ("5000") - also for the aggregate layers, so
// "dk50" and "50" work. City aliases are claimed first, so on a collision the
// city chat wins.
//
// Names with non-ASCII letters ("Ålborg") get two aliases: the ASCII-only
// lowercase ("Ålborg", what the former PHP API matched on) and the full
// lowercase ("ålborg").
export function chatAliases(cities, postnumreFiles) {
  const out = new Map();
  const claim = (alias, chat) => {
    if (!alias || out.has(alias)) return;
    out.set(alias, chat);
  };
  const claimLower = (s, chat) => {
    claim(s.replace(/[A-Z]/g, c => c.toLowerCase()), chat);
    claim(s.toLowerCase(), chat);
  };
  for (const [k, v] of Object.entries(cities)) {
    const chat = chatEntry(k, v);
    claimLower(k, chat);
    if (typeof v.localChat === "string") claimLower(v.localChat.replace(/^#+/, ""), chat);
    if (typeof v.name === "string") claimLower(v.name, chat);
  }
  for (const [k, chat] of Object.entries(postalChats(postnumreFiles))) {
    claim(k, chat);            // dk5000
    claim(k.slice(2), chat);   // 5000
  }
  return out;
}
