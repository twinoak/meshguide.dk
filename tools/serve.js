#!/usr/bin/env node
// serve.js - zero-dependency static dev server (Node's http module only).
//
//   npm start                     serves the repo root on http://localhost:8000
//   node tools/serve.js _site     serves a build output instead
//   PORT=3000 npm start           another port
//
// Directories serve their index.html, every file is sent with Cache-Control:
// no-cache so a browser reload always shows your latest edit, and .js/.mjs
// get a JavaScript MIME type so ES modules load. localhost counts as a secure
// context, so Web Serial and Web Bluetooth work here too.

import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { ROOT } from "./data.js";

const root = resolve(process.argv[2] || ROOT);
const port = Number(process.env.PORT) || 8000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".map": "application/json"
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-cache" });
  res.end(body);
}

const server = createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    return send(res, 400, "Bad request");
  }
  // Resolve inside root only; "/foo/../../etc" can never escape, and dot
  // entries (.git, .github, ...) are not served.
  let file = normalize(join(root, pathname));
  if (file !== root && !file.startsWith(root + sep)) return send(res, 403, "Forbidden");
  if (file.slice(root.length).split(sep).some(seg => seg.startsWith("."))) return send(res, 404, "Not found: " + pathname);

  let st;
  try { st = statSync(file); } catch { return send(res, 404, "Not found: " + pathname); }
  if (st.isDirectory()) {
    if (!pathname.endsWith("/")) {
      res.writeHead(301, { Location: pathname + "/" });
      return res.end();
    }
    file = join(file, "index.html");
    try { st = statSync(file); } catch { return send(res, 404, "No index.html in " + pathname); }
  }

  res.writeHead(200, {
    "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
    "Content-Length": st.size,
    "Cache-Control": "no-cache"
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
});

server.listen(port, () => {
  console.log(`Serving ${root}`);
  console.log(`  http://localhost:${port}/`);
  console.log(`  http://localhost:${port}/edit.html`);
  console.log("Ctrl+C to stop.");
});
