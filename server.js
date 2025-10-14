import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import { WebcastPushConnection } from "tiktok-live-connector";
import XRegExp from "xregexp";

// Utility: normalize text (remove accents/punct, lowercase, trim)
function normalize(txt) {
  if (!txt) return "";
  const stripped = txt
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // diacritics
    .replace(/[^\p{L}\p{N}\s]/gu, "") // punctuation (keep letters/numbers/spaces)
    .toLowerCase()
    .trim();
  return stripped;
}

// App setup
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Serve admin and overlay HTML files from the public directory. These explicit
// routes make it easier to access the pages at /admin and /overlay without
// needing to include the ".html" extension or the "public/" prefix in the
// URL. They also avoid confusion when there are similarly named files at the
// project root (which are not served by express.static). The path module is
// used to construct absolute paths.
import { fileURLToPath } from 'url';
import path from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Admin page at /admin
app.get(["/admin", "/admin.html"], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Overlay page at /overlay
app.get(["/overlay", "/overlay.html"], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

// Game state
let ttConnection = null;
let connectedRoom = null;
let isRunning = false;
let secretWordRaw = "";
let secretWordNorm = "";
let winner = null;
let roundStartedAt = null;
const winnerHighlightMs = 60_000; // 60 seconds
let lastWinAt = 0;

// Added state for masked word and timer
// revealedPositions holds booleans for each character in secretWordRaw. true means
// that character should be shown in the overlay. When a new word is set, all
// positions are initialized to false. Admin actions or gifts can reveal
// individual letters or the entire word by toggling these to true.
let revealedPositions = [];

// roundDurationMs stores the total duration of the current round in
// milliseconds. When the secret word is set, it defaults to 20 seconds
// (matching the rapid‑fire requirement). The admin can adjust the remaining
// time via the update-timer endpoint. The current remaining time can be
// computed as roundDurationMs - (Date.now() - roundStartedAt).
let roundDurationMs = 20_000;

// Basic per-user rate limit: 1 message per 700 ms
const userLastMsgAt = new Map();

// TikTok handlers
async function connectTikTok(uniqueId) {
  if (ttConnection) {
    try {
      ttConnection.disconnect();
    } catch {}
  }
  ttConnection = new WebcastPushConnection(uniqueId);
  const state = await ttConnection.connect();
  connectedRoom = uniqueId;

  io.emit("system", { type: "connected", room: uniqueId, viewerCount: state.roomInfo?.viewerCount ?? null });

  ttConnection.on("chat", (data) => {
    const nickname = data?.nickname || data?.uniqueId || "Unknown";
    const uniqueId = data?.uniqueId || "";
    const userId = String(data?.userId || uniqueId || nickname);
    const text = String(data?.comment || "");

    // Simple per-user rate-limit
    const now = Date.now();
    const last = userLastMsgAt.get(userId) || 0;
    if (now - last < 700) return; // drop message
    userLastMsgAt.set(userId, now);

    // Only judge guesses when round is running and no winner yet
    const normalizedMsg = normalize(text);
    let isCorrect = false;
    const highlightActive = winner && now - lastWinAt < winnerHighlightMs;
    if (isRunning && secretWordNorm && !highlightActive) {
      // Match rule: exact match only (no partial matches)
      isCorrect = normalizedMsg === secretWordNorm;
    }

    // Broadcast the raw chat first
    io.emit("chat", {
      userId,
      uniqueId,
      nickname,
      text,
      ts: now,
      isCorrect,
    });

    // If correct, register winner
    if (isCorrect) {
      winner = { userId, uniqueId, nickname, at: now, guess: text };
      lastWinAt = now;
      io.emit("winner", {
        nickname,
        uniqueId,
        userId,
        guess: text,
        highlightMs: winnerHighlightMs,
      });
    }
  });

  // Connection closed/errors
  ttConnection.on("disconnected", () => {
    io.emit("system", { type: "disconnected" });
    connectedRoom = null;
  });
  ttConnection.on("streamEnd", () => {
    io.emit("system", { type: "stream_end" });
  });
  ttConnection.on("error", (err) => {
    io.emit("system", { type: "error", message: String(err?.message || err) });
  });
}

function disconnectTikTok() {
  try {
    ttConnection?.disconnect();
  } catch {}
  ttConnection = null;
  connectedRoom = null;
}

// Utility: build a masked representation of the secret word. For each
// character in secretWordRaw, return the character itself if the
// corresponding index in revealedPositions is true, otherwise return
// an underscore. If no secret has been set, return an empty string.
function getMaskedWord() {
  if (!secretWordRaw) return "";
  return secretWordRaw.split("").map((ch, idx) => (revealedPositions[idx] ? ch : "_" )).join("");
}

// Admin API
app.post("/api/start", async (req, res) => {
  const { room } = req.body || {};
  if (!room) return res.status(400).json({ error: "Missing 'room' (TikTok username/uniqueId)" });
  try {
    await connectTikTok(room);
    return res.json({ ok: true, room });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/stop", (req, res) => {
  disconnectTikTok();
  isRunning = false;
  return res.json({ ok: true });
});

app.post("/api/set-word", (req, res) => {
  const { word } = req.body || {};
  if (!word) return res.status(400).json({ error: "Missing 'word'" });
  secretWordRaw = String(word);
  secretWordNorm = normalize(secretWordRaw);
  // Initialize revealedPositions to all false so no letters are shown at the start.
  revealedPositions = new Array(secretWordRaw.length).fill(false);
  // Reset round duration and start time. Default duration for each round is
  // 20 seconds, but this can be adjusted via the update‑timer API.
  roundDurationMs = 20_000;
  roundStartedAt = Date.now();
  isRunning = true;
  winner = null;
  lastWinAt = 0;
  // Broadcast that a new round has started. Include the masked word and
  // current time left so clients can display hints and countdowns.
  io.emit("round", {
    status: "started",
    secretLen: secretWordNorm.length,
    maskedWord: getMaskedWord(),
    timeLeftMs: roundDurationMs,
  });
  return res.json({ ok: true, secretLen: secretWordNorm.length });
});

app.post("/api/reset-round", (req, res) => {
  winner = null;
  lastWinAt = 0;
  isRunning = false;
  secretWordRaw = "";
  secretWordNorm = "";
  revealedPositions = [];
  roundDurationMs = 20_000;
  roundStartedAt = null;
  io.emit("round", { status: "reset", maskedWord: "", timeLeftMs: 0 });
  return res.json({ ok: true });
});

// Start reading guesses (only if a secret word is set). This sets the
// running flag so that chat messages are judged. If no secret word is set,
// return an error.
app.post("/api/start-reading", (req, res) => {
  if (!secretWordNorm) {
    return res.status(400).json({ error: "No secret word set" });
  }
  isRunning = true;
  io.emit("round", { status: "reading_started" });
  return res.json({ ok: true });
});

// Stop reading guesses. This disables judging until start-reading or set-word
// is invoked again. The secret word remains stored.
app.post("/api/stop-reading", (req, res) => {
  isRunning = false;
  io.emit("round", { status: "reading_stopped" });
  return res.json({ ok: true });
});

// Adjust the remaining time on the current round. Accepts either 'ms' or
// 'seconds' in the request body. If no round is active or no secret is set,
// return an error. The new duration is computed by adding the elapsed time
// since the round started to the requested remaining time. For example, if
// 5 seconds have already elapsed and the admin requests 30 seconds of
// remaining time, the total duration becomes 35 seconds. The server then
// broadcasts an update so the overlay can refresh the countdown.
app.post("/api/update-timer", (req, res) => {
  if (!secretWordNorm || !roundStartedAt) {
    return res.status(400).json({ error: "No active round to update timer" });
  }
  let { ms, seconds } = req.body || {};
  if (seconds != null && ms == null) {
    ms = Number(seconds) * 1000;
  }
  if (typeof ms !== "number" || isNaN(ms) || ms < 0) {
    return res.status(400).json({ error: "Invalid 'ms' or 'seconds' provided" });
  }
  // Compute elapsed time and set new roundDurationMs
  const elapsed = Date.now() - roundStartedAt;
  roundDurationMs = elapsed + ms;
  // Immediately compute new remaining time (should equal ms)
  const timeLeftMs = Math.max(0, roundDurationMs - (Date.now() - roundStartedAt));
  io.emit("round", {
    status: "timer_updated",
    maskedWord: getMaskedWord(),
    timeLeftMs,
  });
  return res.json({ ok: true, timeLeftMs });
});

// Reveal the entire word. This sets all positions in revealedPositions to true.
// If no secret is set, return an error. After updating the mask, broadcast
// the updated masked word to clients.
app.post("/api/reveal-word", (req, res) => {
  if (!secretWordNorm) {
    return res.status(400).json({ error: "No secret word set" });
  }
  revealedPositions = new Array(secretWordRaw.length).fill(true);
  const maskedWord = getMaskedWord();
  io.emit("mask", { maskedWord });
  return res.json({ ok: true, maskedWord });
});

// Reveal specific letter positions. Accepts 'positions' in the body as a
// semicolon- or comma-separated list of 1-based indices (e.g. "1;3" or
// "2,4"). Invalid indices are ignored. If no secret is set, return an
// error. After updating the mask, broadcast it to clients.
app.post("/api/reveal-letters", (req, res) => {
  if (!secretWordNorm) {
    return res.status(400).json({ error: "No secret word set" });
  }
  const { positions } = req.body || {};
  if (!positions || typeof positions !== "string") {
    return res.status(400).json({ error: "Missing or invalid 'positions'" });
  }
  // Split by semicolon or comma and convert to zero-based indices
  const parts = positions.split(/[;,\s]+/);
  parts.forEach((p) => {
    const idx = parseInt(p, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= revealedPositions.length) {
      revealedPositions[idx - 1] = true;
    }
  });
  const maskedWord = getMaskedWord();
  io.emit("mask", { maskedWord });
  return res.json({ ok: true, maskedWord });
});

app.get("/api/state", (req, res) => {
  const now = Date.now();
  const highlightActive = winner && now - lastWinAt < winnerHighlightMs;
  // Compute time left if a round is active; otherwise 0
  let timeLeftMs = 0;
  if (roundStartedAt && roundDurationMs) {
    const elapsed = Date.now() - roundStartedAt;
    timeLeftMs = Math.max(0, roundDurationMs - elapsed);
  }
  res.json({
    connectedRoom,
    isRunning,
    secretSet: Boolean(secretWordNorm),
    winner: winner ? { ...winner, highlightActive } : null,
    maskedWord: getMaskedWord(),
    timeLeftMs,
  });
});

io.on("connection", (socket) => {
  const now = Date.now();
  const highlightActive = winner && now - lastWinAt < winnerHighlightMs;
  // Compute remaining time for bootstrap payload
  let timeLeftMs = 0;
  if (roundStartedAt && roundDurationMs) {
    const elapsed = Date.now() - roundStartedAt;
    timeLeftMs = Math.max(0, roundDurationMs - elapsed);
  }
  socket.emit("bootstrap", {
    connectedRoom,
    isRunning,
    secretSet: Boolean(secretWordNorm),
    winner: winner ? { ...winner, highlightActive } : null,
    maskedWord: getMaskedWord(),
    timeLeftMs,
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server listening on http://localhost:" + PORT);
});