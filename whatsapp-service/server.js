const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode");
const pino = require("pino");
const path = require("path");
const fs = require("fs");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3001;
// Comma-separated so a key can be rotated with NO downtime: run with
// "new,old", update the callers, then drop the old one.
//
// No fallback, on purpose. This service is public at wa.jsa-whatsapp.us and
// can send WhatsApp messages as real people, read their chat lists and log
// them out. It previously defaulted to a key hardcoded in this PUBLIC repo,
// and the live endpoint accepted it from off-network. A missing key must stop
// the service, never silently open it.
const API_KEYS = String(process.env.WA_API_KEY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (API_KEYS.length === 0) {
  console.error("WA_API_KEY is not set - refusing to start.");
  process.exit(1);
}

// Constant-time compare so a wrong key cannot be narrowed down by timing.
function authorized(presented) {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const given = Buffer.from(presented);
  return API_KEYS.some((k) => {
    const want = Buffer.from(k);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  });
}
const SESSIONS_DIR = path.join(__dirname, "wa-session");

// Silent logger
const logger = pino({ level: "silent" });

// ── Prevent a single bad connection from crashing the whole process ───────────
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (process kept alive):", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (process kept alive):", reason?.message || reason);
});

// ── Sessions map: sessionId -> { sock, isReady, qrCodeData, chatCache, _connecting } ──
const sessions = new Map();

// ── Auth middleware ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!authorized(req.headers["x-api-key"]))
    return res.status(401).json({ error: "Unauthorized" });
  next();
});

// ── Get session ID from request ───────────────────────────────────────────────
function sessionId(req) {
  return (req.headers["x-session-id"] || req.query.session || "default")
    .replace(/[^a-zA-Z0-9_\- ]/g, "_");
}

// ── Connect a session ─────────────────────────────────────────────────────────
async function connectSession(sid) {
  const existing = sessions.get(sid);

  // Already connecting — don't create a second socket
  if (existing?._connecting) return;

  const SESSION_PATH = path.join(SESSIONS_DIR, sid);
  if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });

  // Reuse or create the session state object
  const session = existing || { sock: null, isReady: false, qrCodeData: null, chatCache: [], groupCache: [], groupCacheTs: 0 };
  session._connecting = true;
  sessions.set(sid, session);

  // Cleanly close any previous socket so it stops firing events
  if (session.sock) {
    try { session.sock.end(undefined, true); } catch (_) {}
    session.sock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: ["Teams Broadcast", "Chrome", "1.0"],
    generateHighQualityLinkPreview: false,
  });

  // Register this as the active socket BEFORE setting _connecting = false
  session.sock = sock;
  session._connecting = false;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    // Ignore events from stale sockets — only the current one acts
    if (session.sock !== sock) return;

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`[${sid}] QR code ready.`);
      session.qrCodeData = await qrcode.toDataURL(qr);
      session.isReady = false;
    }

    if (connection === "open") {
      console.log(`[${sid}] WhatsApp connected.`);
      session.isReady = true;
      session.qrCodeData = null;
      try {
        const groups = await sock.groupFetchAllParticipating();
        session.chatCache = Object.values(groups).map((g) => ({
          id: g.id,
          name: g.subject,
          isGroup: true,
        }));
      } catch (_) {}
    }

    if (connection === "close") {
      session.isReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`[${sid}] Connection closed. Code: ${code}. Reconnect: ${!loggedOut}`);

      if (loggedOut) {
        // Logged out — wipe session files and start fresh (new QR)
        fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        session.qrCodeData = null;
        session.isReady = false;
        session.chatCache = [];
        session.sock = null;
        setTimeout(() => connectSession(sid), 3000);
      } else {
        // Transient disconnect — reconnect after a delay
        setTimeout(() => connectSession(sid), 5000);
      }
    }
  });

  // Cache DM chats as they arrive
  sock.ev.on("chats.set", ({ chats }) => {
    if (session.sock !== sock) return;
    const newChats = chats
      .filter((c) => c.name)
      .map((c) => ({
        id: c.id,
        name: c.name,
        isGroup: c.id.endsWith("@g.us"),
      }));
    const ids = new Set(session.chatCache.map((c) => c.id));
    newChats.forEach((c) => { if (!ids.has(c.id)) session.chatCache.push(c); });
  });
}

// ── Auto-restore saved sessions on startup ────────────────────────────────────
if (fs.existsSync(SESSIONS_DIR)) {
  fs.readdirSync(SESSIONS_DIR).forEach((dir) => {
    const full = path.join(SESSIONS_DIR, dir);
    if (fs.statSync(full).isDirectory()) {
      console.log(`Restoring session: ${dir}`);
      connectSession(dir).catch(console.error);
    }
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/status", async (req, res) => {
  const sid = sessionId(req);
  if (!sessions.has(sid)) {
    connectSession(sid).catch(console.error);
    return res.json({ ready: false, has_qr: false, initializing: true, error: null });
  }
  const s = sessions.get(sid);
  res.json({ ready: s.isReady, has_qr: !!s.qrCodeData, initializing: !!s._connecting, error: null });
});

app.get("/qr", (req, res) => {
  const sid = sessionId(req);
  if (!sessions.has(sid)) {
    connectSession(sid).catch(console.error);
    return res.json({ ready: false, qr: null, message: "Initializing, please wait..." });
  }
  const s = sessions.get(sid);
  if (s.isReady) return res.json({ ready: true, qr: null });
  if (!s.qrCodeData) return res.json({ ready: false, qr: null, message: "Generating QR code, please wait..." });
  res.json({ ready: false, qr: s.qrCodeData });
});

app.get("/chats", async (req, res) => {
  const sid = sessionId(req);
  const s = sessions.get(sid);
  if (!s || !s.isReady) return res.status(503).json({ error: "WhatsApp not ready" });
  const force = req.query.force === "1";
  const cacheAge = Date.now() - s.groupCacheTs;
  const cacheValid = s.groupCache.length > 0 && cacheAge < 5 * 60 * 1000;
  try {
    let groupList = s.groupCache;
    if (!cacheValid || force) {
      try {
        const groups = await s.sock.groupFetchAllParticipating();
        groupList = Object.values(groups).map((g) => ({
          id: g.id,
          name: g.subject,
          isGroup: true,
        }));
        s.groupCache = groupList;
        s.groupCacheTs = Date.now();
      } catch (rateErr) {
        // WhatsApp rate-limited the group fetch — fall back to chatCache groups
        if (s.chatCache.length > 0) {
          groupList = s.chatCache.filter((c) => c.isGroup);
          console.log(`[${sid}] groupFetchAllParticipating rate-limited, using chatCache (${groupList.length} groups)`);
        } else {
          return res.status(429).json({ error: rateErr.message });
        }
      }
    }
    const groupIds = new Set(groupList.map((g) => g.id));
    const dms = s.chatCache.filter((c) => !groupIds.has(c.id) && !c.isGroup);
    const all = [...groupList, ...dms].sort((a, b) => a.name.localeCompare(b.name));
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/send", async (req, res) => {
  const sid = sessionId(req);
  const s = sessions.get(sid);
  if (!s || !s.isReady) return res.status(503).json({ error: "WhatsApp not ready" });

  const { chat_ids, message, image_base64, image_mime, images } = req.body;
  if (!chat_ids?.length) return res.status(400).json({ error: "chat_ids required" });

  const results = [];
  for (const chatId of chat_ids) {
    try {
      const imgList = images && images.length > 0
        ? images
        : image_base64
          ? [{ base64: image_base64, mime: image_mime || "image/png" }]
          : [];

      if (imgList.length > 0) {
        for (let i = 0; i < imgList.length; i++) {
          const buf = Buffer.from(imgList[i].base64, "base64");
          const mime = imgList[i].mime || "image/png";
          await s.sock.sendMessage(chatId, {
            image: buf,
            mimetype: mime,
            caption: i === 0 ? (message || undefined) : undefined,
          });
        }
      } else if (message) {
        await s.sock.sendMessage(chatId, { text: message });
      }
      results.push({ chatId, ok: true });
    } catch (err) {
      results.push({ chatId, ok: false, error: err.message });
    }
  }
  res.json({ results });
});

app.post("/logout", async (req, res) => {
  const sid = sessionId(req);
  const s = sessions.get(sid);
  if (!s) return res.json({ ok: true });
  try { await s.sock?.logout(); } catch (_) {}
  const SESSION_PATH = path.join(SESSIONS_DIR, sid);
  fs.rmSync(SESSION_PATH, { recursive: true, force: true });
  sessions.delete(sid);
  res.json({ ok: true });
  // Recreate fresh session so QR appears immediately
  setTimeout(() => connectSession(sid), 2000);
});

// ── Start ─────────────────────────────────────────────────────────────────────
// Loopback only. nginx terminates TLS and proxies to localhost:3001, so
// binding 0.0.0.0 put a single ufw rule between this service and the internet.
app.listen(PORT, "127.0.0.1", () =>
  console.log(`WhatsApp service running on 127.0.0.1:${PORT}`)
);
