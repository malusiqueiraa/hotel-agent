// Hotel Estrella guest assistant - walking skeleton server.
// Plain Node, built-in http only. One extra package: @anthropic-ai/sdk.
// Serves the guest page from public/ and handles POST /api/message.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./server/agent.js";

// --- tiny .env reader -------------------------------------------------------
// Reads KEY=value lines from .env into process.env. No dependency.
// We never log the value and never send it to the browser.
async function loadEnv() {
  try {
    const text = await readFile(new URL("./.env", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // No .env file. The server still starts; the model call will fail clearly.
  }
}

// --- system prompt ----------------------------------------------------------
// The system prompt is the text of system-prompt.md, with the contents of
// hotel-policies.md appended as context under a "Hotel policies" heading.
let systemPrompt = "";

async function loadSystemPrompt() {
  const prompt = await readFile(
    new URL("./system-prompt.md", import.meta.url),
    "utf8",
  );

  let policies = "";
  try {
    policies = await readFile(
      new URL("./hotel-policies.md", import.meta.url),
      "utf8",
    );
  } catch {
    // No policies file yet. The prompt still loads; the heading is left empty.
  }

  systemPrompt = prompt.trimEnd() + "\n\n# Hotel policies\n\n" + policies.trim();
}

// --- static file serving ----------------------------------------------------
const publicDir = fileURLToPath(new URL("./public", import.meta.url));

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

async function serveStatic(req, res) {
  // Map "/" to index.html; keep the path inside public/.
  const path = req.url === "/" ? "/index.html" : req.url;
  const safe = path.replace(/\.\.+/g, "").split("?")[0];
  const filePath = join(publicDir, safe);

  try {
    const body = await readFile(filePath);
    const type = contentTypes[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

// --- read the JSON body of a request ---------------------------------------
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// --- the model client -------------------------------------------------------
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- POST /api/message ------------------------------------------------------
async function handleMessage(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Could not read the request." }));
    return;
  }

  const name = (body.name || "").trim();
  const email = (body.email || "").trim();
  const message = (body.message || "").trim();

  if (!name || !email || !message) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Please fill in all three fields." }));
    return;
  }

  try {
    const reply = await runAgent({
      name,
      email,
      message,
      systemPrompt,
      anthropic,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ reply }));
  } catch (err) {
    console.error("Model call failed:", err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Sorry, we could not get a reply just now." }));
  }
}

// --- router -----------------------------------------------------------------
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/message") {
    handleMessage(req, res);
    return;
  }
  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }
  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
});

const PORT = process.env.PORT || 3000;
await loadEnv();
await loadSystemPrompt();
server.listen(PORT, () => {
  console.log(`Hotel Estrella guest assistant running on http://localhost:${PORT}`);
});
