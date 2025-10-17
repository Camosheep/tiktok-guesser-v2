import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import { WebcastPushConnection } from "tiktok-live-connector";
import XRegExp from "xregexp";
import fs from "fs";

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
// Serve the winner sound file
app.get('/sound.wav', (req, res) => {
  res.sendFile(path.join(__dirname, 'sound.wav'));
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

// ======================
// Persistence and Tiers
// ======================

// The users object stores per-user statistics such as display name, win count
// and tier. Tiers are based on win totals: 'red' for 1 win, 'gold' for 2
// wins, 'platinum' for 3 or more wins, and 'none' for no wins. This data
// may be persisted to disk between server restarts when PERSIST_STATE is
// enabled via the environment variable. The data file is stored in the
// project root next to this script.

const DATA_FILE = path.join(__dirname, "users.json");
const PERSIST_STATE = process.env.PERSIST_STATE === "true";
let users = {};

// Load user data from disk if persistence is enabled. If the file is not
// present or cannot be parsed, start with an empty object. This function
// runs once at startup.
function loadUsers() {
  if (!PERSIST_STATE) {
    users = {};
    return;
  }
  try {
    const data = fs.readFileSync(DATA_FILE, "utf8");
    users = JSON.parse(data);
  } catch (e) {
    users = {};
  }
}

// Save user data to disk if persistence is enabled. Writes the users object
// in pretty JSON format. Errors are ignored to prevent crashes.
function saveUsers() {
  if (!PERSIST_STATE) return;
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
  } catch (e) {
    // ignore write errors
  }
}

// Compute a tier string based on the total number of wins. This helper
// centralises tier thresholds so that any future changes are easier to make.
function computeTier(winsTotal) {
  if (winsTotal >= 3) return "platinum";
  if (winsTotal >= 2) return "gold";
  if (winsTotal >= 1) return "red";
  return "none";
}

// Retrieve a user record by ID, creating a new record if necessary. The
// display name is updated if provided and different from the stored name.
function getUser(userId, nickname) {
  let u = users[userId];
  if (!u) {
    u = { userId, display_name: nickname || userId, wins_total: 0, tier: "none" };
    users[userId] = u;
  } else {
    if (nickname && u.display_name !== nickname) {
      u.display_name = nickname;
    }
  }
  return u;
}

// Increment a user's win count and update their tier accordingly. Returns
// true if the tier has changed, which clients can use to trigger tier-up
// notifications. Persist changes to disk if enabled.
function incrementUserWins(user) {
  user.wins_total++;
  const newTier = computeTier(user.wins_total);
  const changed = newTier !== user.tier;
  user.tier = newTier;
  saveUsers();
  return changed;
}

// Reset all users to their default state (no wins and no tier) and
// persist the cleared state. This can be exposed via an admin endpoint.
function resetAllUsers() {
  users = {};
  saveUsers();
}

// Immediately load any persisted user data on server startup.
loadUsers();

// ==================
// Game Mode & Polls
// ==================

// Current game mode. "classic" requires exact matches for winners and does
// not provide any hints. "rapid" uses position locks so that incorrect
// guesses which match letters in the correct position reveal those letters
// to all players. The default is classic.
let gameMode = "classic";

// Poll state for live voting. When a poll is active, pollState is an object
// with the question, an array of options, a tallies map, a Set of userIds
// that have voted (to enforce one vote per user), and the timestamp when
// the poll ends. When no poll is active, pollState is null.
let pollState = null;

// End the active poll and apply the winning mode. If there is a tie, the
// current game mode remains unchanged. Emits pollEnd and state events to
// clients. Called automatically when the poll time expires.
function endPoll() {
  if (!pollState) return;
  const { options, tallies } = pollState;
  let winner = gameMode;
  let maxVotes = -1;
  for (const opt of options) {
    const votes = tallies[opt] ?? 0;
    if (votes > maxVotes) {
      winner = opt;
      maxVotes = votes;
    } else if (votes === maxVotes) {
      // tie: keep current winner
    }
  }
  gameMode = winner;
  io.emit("pollEnd", { winner, tallies });
  // Broadcast the new mode to all clients
  io.emit("state", { mode: gameMode });
  pollState = null;
}

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

    // Normalize message for case-insensitive comparison
    const normalizedMsg = normalize(text);
    let isCorrect = false;
    const highlightActive = winner && now - lastWinAt < winnerHighlightMs;
    // Only judge guesses when reading is enabled, a secret is set and the
    // winner popup is not currently active
    if (isRunning && secretWordNorm && !highlightActive) {
      // Match rule: exact match only (no partial matches) for both modes. In
      // rapid mode incorrect guesses may reveal letters but only exact match
      // declares a winner.
      isCorrect = normalizedMsg === secretWordNorm;
    }

    // Voting: if a poll is active and the message exactly matches one of
    // the options, count it as a vote. Users may vote only once per poll.
    if (pollState) {
      const opt = normalizedMsg.trim();
      if (!pollState.voters.has(userId) && pollState.options.includes(opt)) {
        pollState.voters.add(userId);
        pollState.tallies[opt] = (pollState.tallies[opt] || 0) + 1;
        io.emit("pollUpdate", { tallies: pollState.tallies });
      }
    }

    // Rapid mode: apply position locks on incorrect guesses. When the game
    // mode is rapid and the guess is not correct, reveal letters that are
    // correctly positioned in the guess. Use the normalized secret and
    // normalized guess for comparison but reveal letters from the raw word.
    if (gameMode === "rapid" && isRunning && secretWordNorm && !isCorrect) {
      const guessNorm = normalizedMsg;
      const secretNorm = secretWordNorm;
      const maxLen = Math.min(secretNorm.length, guessNorm.length);
      for (let i = 0; i < maxLen; i++) {
        if (guessNorm[i] === secretNorm[i]) {
          revealedPositions[i] = true;
        }
      }
      const maskedWord = getMaskedWord();
      io.emit("mask", { maskedWord });
    }

    // Retrieve the user record (creating it if needed) and send the chat
    // message with tier information. The tier is looked up before
    // incrementing wins for a correct guess.
    const userRecord = getUser(userId, nickname);

    io.emit("chat", {
      userId,
      uniqueId,
      nickname,
      text,
      ts: now,
      isCorrect,
      tier: userRecord.tier,
    });

    // On correct guess, record the winner, update the user's stats and
    // broadcast both winner and userUpdate events. The winner popup
    // highlights for a fixed duration. Also reveal the entire word when
    // someone guesses correctly so that any hidden letters appear.
    if (isCorrect) {
      winner = { userId, uniqueId, nickname, at: now, guess: text };
      lastWinAt = now;
      // Reveal entire word on correct guess
      revealedPositions = new Array(secretWordRaw.length).fill(true);
      const maskedWord = getMaskedWord();
      io.emit("mask", { maskedWord });
      // Update user wins and tier
      const tierChanged = incrementUserWins(userRecord);
      io.emit("winner", {
        nickname,
        uniqueId,
        userId,
        guess: text,
        highlightMs: winnerHighlightMs,
      });
      // Emit userUpdate with wins and tier (for leaderboards or tier-up toast)
      io.emit("userUpdate", {
        userId,
        nickname,
        wins_total: userRecord.wins_total,
        tier: userRecord.tier,
        tierChanged,
      });

      // Broadcast updated leaderboard so overlays can display top players
      broadcastLeaderboard();
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

// Compute a leaderboard from the users object. Sorts by wins_total in
// descending order and returns an array of entries with userId,
// display_name, wins_total and tier. Limits the result to the top
// 10 players. If no users have any wins yet, returns an empty array.
function computeLeaderboard() {
  const arr = Object.values(users).map((u) => ({
    userId: u.userId,
    display_name: u.display_name,
    wins_total: u.wins_total,
    tier: u.tier,
  }));
  arr.sort((a, b) => b.wins_total - a.wins_total);
  return arr.filter((x) => x.wins_total > 0).slice(0, 10);
}

// Broadcast the current leaderboard to all connected overlays. The
// leaderboard event contains an array of entries sorted by wins.
function broadcastLeaderboard() {
  const leaderboard = computeLeaderboard();
  io.emit("leaderboard", { leaderboard });
}

app.post("/api/stop", (req, res) => {
  disconnectTikTok();
  isRunning = false;
  return res.json({ ok: true });
});

// Change the current game mode. Accepts { mode: "classic" | "rapid" }
// and optional settings (currently unused). Changing the mode does not
// affect rounds in progress; it influences how future guesses are handled.
app.post("/api/mode", (req, res) => {
  const { mode } = req.body || {};
  if (!mode || (mode !== "classic" && mode !== "rapid")) {
    return res.status(400).json({ error: "Invalid or missing 'mode'" });
  }
  gameMode = mode;
  io.emit("state", { mode: gameMode });
  return res.json({ ok: true, mode: gameMode });
});

// Start a live poll to allow viewers to vote between two or more options.
// Accepts { question, options, durationMs }. Only one poll can be active
// at a time; attempts to start another will return an error. Each
// participant may vote only once. When the duration elapses, the poll
// automatically ends and applies the winning mode (if the options are
// modes). Clients are notified via pollStart, pollUpdate and pollEnd
// events.
app.post("/api/poll/start", (req, res) => {
  const { question, options, durationMs } = req.body || {};
  if (pollState) {
    return res.status(400).json({ error: "A poll is already running" });
  }
  if (!Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: "Poll must have at least two options" });
  }
  const durMs = Number(durationMs) || 20_000;
  const tallies = {};
  options.forEach((opt) => { tallies[opt] = 0; });
  pollState = {
    question: question || "Choose a mode",
    options,
    tallies,
    voters: new Set(),
    endsAt: Date.now() + durMs,
  };
  io.emit("pollStart", { question: pollState.question, options: pollState.options, endsAt: pollState.endsAt });
  // Schedule automatic poll end
  setTimeout(() => {
    endPoll();
  }, durMs);
  return res.json({ ok: true, poll: { question: pollState.question, options: pollState.options, endsAt: pollState.endsAt } });
});

// Stop the current poll early. If no poll is active, return an error.
app.post("/api/poll/stop", (req, res) => {
  if (!pollState) {
    return res.status(400).json({ error: "No poll is currently running" });
  }
  endPoll();
  return res.json({ ok: true });
});

// Reset all user tiers and win counts. Useful for clearing the scoreboard.
app.post("/api/users/reset", (req, res) => {
  resetAllUsers();
  io.emit("state", { users });
  broadcastLeaderboard();
  return res.json({ ok: true });
});

//
// ====================
// Monetization / Boosts
// ====================

// Add extra time to the current round. This endpoint is used by the
// Donut gift/button. It accepts { ms } in the body (number of
// milliseconds to add) and increases the round duration accordingly. If
// there is no active round or no secret word, it returns an error. A
// boost event is emitted so the overlay can show a toast and update
// the countdown.
app.post("/api/boost/add-time", (req, res) => {
  if (!secretWordNorm || !roundStartedAt) {
    return res.status(400).json({ error: "No active round" });
  }
  let { ms } = req.body || {};
  ms = Number(ms) || 0;
  if (ms <= 0) {
    return res.status(400).json({ error: "Invalid 'ms'" });
  }
  // Increase total round duration by the requested amount
  roundDurationMs += ms;
  const timeLeftMs = Math.max(0, roundDurationMs - (Date.now() - roundStartedAt));
  io.emit("boost", { type: "add-time", ms });
  // Broadcast updated timer so the overlay resets the countdown
  io.emit("round", { status: "timer_updated", maskedWord: getMaskedWord(), timeLeftMs });
  return res.json({ ok: true, timeLeftMs });
});

// Reveal a random unrevealed letter. This endpoint implements the Money
// Gun gift/button. It picks one of the unrevealed positions at random and
// marks it as revealed. If all letters are already revealed or no
// secret is set, returns an error. Emits a boost event and a mask
// update. Use update-timer if you want to extend time separately.
app.post("/api/boost/reveal-letter", (req, res) => {
  if (!secretWordNorm) {
    return res.status(400).json({ error: "No secret word set" });
  }
  // Build a list of indices that are currently unrevealed
  const unrevealed = [];
  for (let i = 0; i < revealedPositions.length; i++) {
    if (!revealedPositions[i]) unrevealed.push(i);
  }
  if (unrevealed.length === 0) {
    return res.status(400).json({ error: "All letters are already revealed" });
  }
  const idx = unrevealed[Math.floor(Math.random() * unrevealed.length)];
  revealedPositions[idx] = true;
  const maskedWord = getMaskedWord();
  io.emit("boost", { type: "reveal-letter", index: idx });
  io.emit("mask", { maskedWord });
  return res.json({ ok: true, index: idx, maskedWord });
});

// Reveal the entire word via the Galaxy gift/button. This simply calls
// the existing reveal-word logic. It emits a boost event and returns
// the fully revealed word. The existing /api/reveal-word endpoint can
// also be used directly by the admin, but this separates the concept
// of a monetization trigger from manual admin control.
app.post("/api/boost/reveal-word", (req, res) => {
  if (!secretWordNorm) {
    return res.status(400).json({ error: "No secret word set" });
  }
  // Reuse the existing reveal-word logic
  revealedPositions = new Array(secretWordRaw.length).fill(true);
  const maskedWord = getMaskedWord();
  io.emit("boost", { type: "reveal-word" });
  io.emit("mask", { maskedWord });
  return res.json({ ok: true, maskedWord });
});

// Tiny Diny: prompt plus add time. Accepts { text, extraTimeMs }. The
// text could be used to ask a question in chat or overlay; for now
// we'll ignore it and simply add the extra time (default 10000 ms). A
// boost event is emitted. The overlay may show a custom animation.
app.post("/api/boost/prompt", (req, res) => {
  if (!secretWordNorm || !roundStartedAt) {
    return res.status(400).json({ error: "No active round" });
  }
  let { extraTimeMs } = req.body || {};
  extraTimeMs = Number(extraTimeMs) || 10000;
  roundDurationMs += extraTimeMs;
  const timeLeftMs = Math.max(0, roundDurationMs - (Date.now() - roundStartedAt));
  io.emit("boost", { type: "prompt", ms: extraTimeMs });
  io.emit("round", { status: "timer_updated", maskedWord: getMaskedWord(), timeLeftMs });
  return res.json({ ok: true, timeLeftMs });
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
    mode: gameMode,
    users,
    poll: pollState ? { question: pollState.question, options: pollState.options, tallies: pollState.tallies, endsAt: pollState.endsAt } : null,
    leaderboard: computeLeaderboard(),
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
    mode: gameMode,
    users,
    poll: pollState ? { question: pollState.question, options: pollState.options, tallies: pollState.tallies, endsAt: pollState.endsAt } : null,
    leaderboard: computeLeaderboard(),
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server listening on http://localhost:" + PORT);
});
