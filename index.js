"use strict";

const express = require("express");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BODY_LIMIT = process.env.BODY_LIMIT || "2mb";
const AUTH_DIR = process.env.AUTH_DIR || "auth_info";
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || "91";
const STARTUP_VERSION = [2, 3000, 1015901307];

let sock = null;
let currentQR = "";
let isStarting = false;

app.disable("x-powered-by");
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

async function startSock() {
  if (isStarting) return;
  isStarting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version = STARTUP_VERSION;
    try {
      const fetched = await fetchLatestBaileysVersion();
      if (Array.isArray(fetched.version)) version = fetched.version;
      console.log("WhatsApp version:", version.join("."));
    } catch (err) {
      console.log("Version fetch failed, using backup version.");
    }

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      browser: ["Bagheera Billing OS", "Chrome", "1.0.0"],
      logger: pino({ level: process.env.LOG_LEVEL || "silent" }),
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", update => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        currentQR = qr;
        console.log("QR ready. Open /qr to scan.");
      }
      if (connection === "open") {
        currentQR = "";
        console.log("WhatsApp engine ready.");
      }
      if (connection === "close") {
        currentQR = "";
        const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log("Connection closed. Code:", statusCode, "Reconnect:", shouldReconnect);
        sock = null;
        if (shouldReconnect) setTimeout(startSock, 2000);
      }
    });
  } catch (err) {
    console.error("Startup error:", err && err.stack ? err.stack : err);
    sock = null;
    setTimeout(startSock, 5000);
  } finally {
    isStarting = false;
  }
}

function assertReady() {
  if (!sock) throw httpError(503, "WhatsApp engine is not ready.");
  if (!sock.user || !sock.user.id) throw httpError(503, "WhatsApp is still syncing. Try again shortly.");
}

function cleanNumber(number) {
  let cleaned = String(number || "").replace(/\D/g, "");
  if (!cleaned) return "";
  if (cleaned.length === 10) cleaned = DEFAULT_COUNTRY_CODE + cleaned;
  return cleaned;
}

function jidFor(number) {
  const cleaned = cleanNumber(number);
  if (!cleaned) throw httpError(400, "Valid phone number is required.");
  return `${cleaned}@s.whatsapp.net`;
}

function normalizeDocumentPayload(body) {
  const fileName = sanitizeFileName(body.fileName || body.filename || "Bagheera_Document.html");
  const mimetype = body.mimeType || body.mimetype || "text/html";
  let buffer;

  if (body.base64) {
    const raw = String(body.base64).replace(/^data:[^;]+;base64,/, "");
    buffer = Buffer.from(raw, "base64");
  } else if (body.html) {
    buffer = Buffer.from(String(body.html), "utf8");
  } else if (body.textFile) {
    buffer = Buffer.from(String(body.textFile), "utf8");
  } else {
    throw httpError(400, "Document payload must include html or base64.");
  }

  if (!buffer.length) throw httpError(400, "Document payload is empty.");
  return { fileName, mimetype, buffer };
}

function sanitizeFileName(fileName) {
  const safe = String(fileName || "document.html").replace(/[\\/:*?"<>|]+/g, "_").trim();
  return safe || "document.html";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sendError(res, err) {
  const status = err.status || 500;
  res.status(status).json({ ok: false, message: err.message || "Internal error" });
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Bagheera WhatsApp API",
    ready: Boolean(sock && sock.user && sock.user.id),
    qrAvailable: Boolean(currentQR)
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    ready: Boolean(sock && sock.user && sock.user.id),
    uptime: process.uptime(),
    heapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
  });
});

app.get("/qr", (req, res) => {
  if (!currentQR) {
    return res.send("<!doctype html><html><body style='font-family:Arial,sans-serif;text-align:center;margin-top:15vh'><h2>QR is not ready or already scanned.</h2><p>Refresh after a few seconds if the session is still connecting.</p></body></html>");
  }
  res.send(`<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scan WhatsApp QR</title></head>
<body style="display:flex;min-height:100vh;align-items:center;justify-content:center;flex-direction:column;background:#f0f2f5;font-family:Arial,sans-serif">
  <h2>Scan with WhatsApp Business</h2>
  <div id="qrcode" style="background:white;padding:20px;border-radius:12px;box-shadow:0 10px 25px rgba(15,23,42,.18)"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <script>new QRCode(document.getElementById("qrcode"),{text:${JSON.stringify(currentQR)},width:256,height:256});</script>
</body>
</html>`);
});

app.post("/send-message", async (req, res) => {
  try {
    assertReady();
    const { number, message } = req.body || {};
    if (!message) throw httpError(400, "Message is required.");
    await sock.sendMessage(jidFor(number), { text: String(message) });
    res.json({ ok: true, type: "message" });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/send-document", async (req, res) => {
  try {
    assertReady();
    const { number, message, caption } = req.body || {};
    const doc = normalizeDocumentPayload(req.body || {});
    await sock.sendMessage(jidFor(number), {
      document: doc.buffer,
      mimetype: doc.mimetype,
      fileName: doc.fileName,
      caption: String(caption || message || "")
    });
    res.json({ ok: true, type: "document", fileName: doc.fileName, bytes: doc.buffer.length });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/send-sequence", async (req, res) => {
  try {
    assertReady();
    const body = req.body || {};
    const number = body.number;
    const firstMessage = body.firstMessage || body.message || "";
    const followupMessage = body.followupMessage || "";
    const delayMs = body.delayMs == null ? 2000 : Number(body.delayMs);
    const documentBody = {
      fileName: body.firstFileName || body.fileName || "Receipt.html",
      mimeType: body.firstMimeType || body.mimeType || "text/html",
      html: body.firstHtml || body.html,
      base64: body.firstBase64 || body.base64
    };
    const doc = normalizeDocumentPayload(documentBody);
    const jid = jidFor(number);

    await sock.sendMessage(jid, {
      document: doc.buffer,
      mimetype: doc.mimetype,
      fileName: doc.fileName,
      caption: String(firstMessage)
    });

    if (followupMessage) {
      await sleep(delayMs);
      await sock.sendMessage(jid, { text: String(followupMessage) });
    }

    res.json({ ok: true, type: "sequence", fileName: doc.fileName, bytes: doc.buffer.length, delayMs });
  } catch (err) {
    sendError(res, err);
  }
});

app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") return res.status(413).json({ ok: false, message: "Payload too large. Reduce HTML size or BODY_LIMIT." });
  sendError(res, err);
});

app.listen(PORT, () => {
  console.log(`Bagheera WhatsApp API listening on ${PORT}`);
  startSock();
});
