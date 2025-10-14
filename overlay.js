const chatEl = document.getElementById("chat");
const statusEl = document.getElementById("overlay-status");
const winnerEl = document.getElementById("winner");

// Poll status element. Displays live vote tallies for mode selection.
const pollEl = document.getElementById("poll");

// Elements for displaying the masked word and countdown timer. The masked word
// shows underscores and revealed letters. The timer is displayed as a
// minutes:seconds string (no progress bar) so it is easier to read on mobile.
const maskedWordEl = document.getElementById("maskedWord");
const timerTextEl = document.getElementById("timerText");

// Boost hint element. Used to cycle subtle monetization hints and show
// immediate feedback when a boost action is triggered. Initially hidden.
const boostHintEl = document.getElementById("boostHint");

// Define the rotation of hint messages. These hints subtly remind viewers
// of the available boosts and their effects. They will rotate every
// 90–120 seconds. You can tweak the messages or durations in admin if
// necessary. Random intervals add slight unpredictability.
const boostHints = [
  "⏱ Tiny Diny adds +10s",
  "🍩 Donut adds +30s",
  "💸 Money Gun reveals a letter",
  "🌌 Galaxy reveals the word",
];
let hintIndex = 0;
let nextHintAt = Date.now() + 90_000;

function rotateHint() {
  const now = Date.now();
  if (now >= nextHintAt) {
    // Show next hint and schedule the next rotation between 90–120s
    boostHintEl.style.display = "block";
    boostHintEl.textContent = boostHints[hintIndex % boostHints.length];
    hintIndex++;
    // Schedule next rotation with some randomness (90–120s)
    const interval = 90_000 + Math.floor(Math.random() * 30_000);
    nextHintAt = now + interval;
  }
  // Fades out the hint slowly if there is no boost message overriding it
  // After 4 seconds of display, reduce opacity to 0 to avoid clutter
  if (boostHintEl.style.display === "block" && boostHintEl.dataset.temp !== "true") {
    const displayTime = 4000;
    // compute how long the current hint has been visible; use timestamp in element dataset
    if (!boostHintEl.dataset.shownAt) boostHintEl.dataset.shownAt = String(now);
    const visibleFor = now - Number(boostHintEl.dataset.shownAt);
    if (visibleFor > displayTime) {
      boostHintEl.style.opacity = "0";
      // After fade-out, hide completely and reset dataset
      setTimeout(() => {
        if (boostHintEl.dataset.temp !== "true") {
          boostHintEl.style.display = "none";
          boostHintEl.style.opacity = "0.8";
          boostHintEl.dataset.shownAt = "";
        }
      }, 500);
    }
  }
}

// Rotate hints regularly. The interval checks every 5 seconds whether to
// display a new hint. Using a timer rather than one long setTimeout
// ensures the logic adapts if the page regains focus at a later time.
setInterval(rotateHint, 5000);

// Track the maximum remaining time (ms) for the current round and the exact
// timestamp when the round should end. These values are used to update
// the timer display (minutes:seconds). They are reset when a new round starts
// or when the timer is adjusted via the admin panel.
let maxTimeLeftMs = 0;
let roundEndAt = 0;

let hasSecret = false;
let highlightUntil = 0;

// Render poll tallies into the poll element. Expects an object with
// properties: options (array of option names), tallies (map of option -> count),
// endsAt (optional timestamp), ended (optional boolean) and winner (optional).
function renderPoll(info) {
  if (!info || !info.options) return;
  const { options, tallies, endsAt, ended, winner } = info;
  const total = options.reduce((sum, opt) => sum + (tallies && tallies[opt] ? tallies[opt] : 0), 0);
  const lines = [];
  options.forEach((opt) => {
    const count = tallies && tallies[opt] ? tallies[opt] : 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    lines.push(`${opt}: ${count} (${pct}%)`);
  });
  if (ended && winner) {
    lines.push(`Winner: ${winner}`);
  } else if (endsAt) {
    const secsLeft = Math.max(0, Math.floor((endsAt - Date.now()) / 1000));
    lines.push(`Time left: ${secsLeft}s`);
  }
  pollEl.textContent = lines.join(" | ");
}

function addMessage({ nickname, text, isCorrect, tier }) {
  const row = document.createElement("div");
  row.className = "msg";
  const nick = document.createElement("span");
  nick.className = "nick";
  // Apply tier-based colour to the nickname. If tier is undefined or none,
  // fall back to the accent color defined in CSS variables.
  let colour = '';
  if (tier === "red") colour = "var(--tier-red)";
  else if (tier === "gold") colour = "var(--tier-gold)";
  else if (tier === "platinum") colour = "var(--tier-platinum)";
  if (colour) nick.style.color = colour;
  nick.textContent = nickname + ":";
  const body = document.createElement("span");
  body.className = "text";
  body.textContent = " " + text;
  if (hasSecret) {
    body.classList.add(isCorrect ? "right" : "wrong");
  }
  row.appendChild(nick);
  row.appendChild(body);
  chatEl.appendChild(row);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// Display a small green winner popup for the specified duration.
// Only the TikTok nickname is shown per user request.
function showWinner({ nickname, guess, highlightMs }) {
  const endAt = Date.now() + (highlightMs || 60000);
  highlightUntil = endAt;
  // Use winnerPopup styling for the popup appearance
  winnerEl.className = "winnerPopup";
  winnerEl.style.display = "block";
  // Compose the popup text: WINNER: @nickname
  winnerEl.textContent = `WINNER: ${nickname}`;
}

function clearWinnerBannerIfExpired() {
  if (highlightUntil && Date.now() > highlightUntil) {
    winnerEl.style.display = "none";
    highlightUntil = 0;
  }
}

setInterval(clearWinnerBannerIfExpired, 1000);

const socket = io();

socket.on("bootstrap", (state) => {
  statusEl.textContent = state.connectedRoom
    ? `Connected to @${state.connectedRoom}`
    : `Not connected`;
  hasSecret = !!state.secretSet;
  if (state.winner?.highlightActive) {
    showWinner({
      nickname: state.winner.nickname,
      guess: state.winner.guess,
      highlightMs: state.winner.at + 60000 - Date.now(),
    });
  }
  // Show poll status if a poll is active
  if (state.poll) {
    pollEl.style.display = "block";
    renderPoll(state.poll);
  } else {
    pollEl.style.display = "none";
    pollEl.textContent = "";
  }
  // Initialize the masked word display and timer based on server state
  if (state.maskedWord) {
    updateMask(state.maskedWord);
    if (typeof state.timeLeftMs === "number" && state.timeLeftMs > 0) {
      startTimer(state.timeLeftMs);
    }
  } else {
    updateMask("");
    // Hide timer text when no round is active
    timerTextEl.style.display = "none";
  }
});

socket.on("system", (msg) => {
  if (msg.type === "connected") {
    statusEl.textContent = `Connected to @${msg.room} (${msg.viewerCount ?? "?"} viewers)`;
  } else if (msg.type === "disconnected") {
    statusEl.textContent = `Disconnected`;
  } else if (msg.type === "stream_end") {
    statusEl.textContent = `Stream ended`;
  } else if (msg.type === "error") {
    statusEl.textContent = `Error: ${msg.message}`;
  }
});

socket.on("round", (msg) => {
  if (msg.status === "started") {
    // A new round begins: enable secret and reset winner popup
    hasSecret = true;
    winnerEl.style.display = "none";
    highlightUntil = 0;
    // Update the masked word and start the timer
    if (msg.maskedWord) updateMask(msg.maskedWord);
    if (typeof msg.timeLeftMs === "number" && msg.timeLeftMs > 0) {
      startTimer(msg.timeLeftMs);
    }
  } else if (msg.status === "reset") {
    // Round reset: disable secret and clear winner
    hasSecret = false;
    winnerEl.style.display = "none";
    highlightUntil = 0;
    // Hide masked word and timer display
    updateMask("");
    timerTextEl.style.display = "none";
  } else if (msg.status === "reading_started" || msg.status === "reading_stopped") {
    // When reading is toggled, hide any existing winner popup
    winnerEl.style.display = "none";
    highlightUntil = 0;
  } else if (msg.status === "timer_updated") {
    // Timer was adjusted: update mask and restart timer with new value
    if (msg.maskedWord) updateMask(msg.maskedWord);
    if (typeof msg.timeLeftMs === "number") {
      startTimer(msg.timeLeftMs);
    }
  }
});

socket.on("chat", (data) => addMessage(data));
socket.on("winner", (data) => showWinner(data));

// Listen for userUpdate events to optionally display tier-up notifications or
// update any future leaderboard. Currently no UI is added for this but
// hooks are in place for future enhancements.
socket.on("userUpdate", (data) => {
  // Placeholder for future tier-up notifications. If tierChanged is true,
  // you could display a small toast. For now we do nothing.
});

// Poll events: show poll progress and results
socket.on("pollStart", (info) => {
  pollEl.style.display = "block";
  renderPoll({ options: info.options, tallies: {}, endsAt: info.endsAt });
});
socket.on("pollUpdate", (msg) => {
  if (msg && msg.tallies) {
    renderPoll({ options: Object.keys(msg.tallies), tallies: msg.tallies });
  }
});
socket.on("pollEnd", (msg) => {
  renderPoll({ options: Object.keys(msg.tallies), tallies: msg.tallies, ended: true, winner: msg.winner });
  // hide poll after a delay
  setTimeout(() => {
    pollEl.style.display = "none";
    pollEl.textContent = "";
  }, 5000);
});

// When a boost event is received, show an immediate toast in the boostHint
// element. Mark the toast as temporary so that the hint rotation logic
// doesn’t override or fade it prematurely. After a short duration, hide
// the toast and resume the regular hint rotation.
socket.on("boost", (data) => {
  if (!data) return;
  let msg = "";
  if (data.type === "add-time") {
    const secs = Math.round((data.ms || 0) / 1000);
    msg = `+${secs}s added!`;
  } else if (data.type === "reveal-letter") {
    msg = "A letter was revealed!";
  } else if (data.type === "reveal-word") {
    msg = "The word was revealed!";
  } else if (data.type === "prompt") {
    const secs = Math.round((data.ms || 0) / 1000);
    msg = `+${secs}s bonus!`;
  }
  if (msg) {
    boostHintEl.dataset.temp = "true";
    boostHintEl.style.display = "block";
    boostHintEl.style.opacity = "1";
    boostHintEl.textContent = msg;
    // Clear any prior fade-out timers by removing dataset.shownAt
    boostHintEl.dataset.shownAt = String(Date.now());
    // Hide the toast after 4 seconds and resume hint rotation
    setTimeout(() => {
      boostHintEl.style.display = "none";
      boostHintEl.style.opacity = "0.8";
      delete boostHintEl.dataset.temp;
      delete boostHintEl.dataset.shownAt;
    }, 4000);
  }
});

// When the server broadcasts a mask update, update the displayed word. This
// event is emitted after specific letters or the entire word are revealed.
socket.on("mask", (msg) => {
  if (msg && msg.maskedWord != null) {
    updateMask(msg.maskedWord);
  }
});

// Update the masked word display. Adds spaces between characters for
// readability on mobile. If the string is empty, hide the element.
function updateMask(masked) {
  if (!masked) {
    maskedWordEl.style.display = "none";
    maskedWordEl.textContent = "";
    return;
  }
  maskedWordEl.style.display = "flex";
  maskedWordEl.textContent = masked.split("").join(" ");
}

// Start or restart the timer bar. Sets maxTimeLeftMs and roundEndAt
// accordingly and makes the timer visible. Immediately updates the bar
// so users see an accurate indicator without waiting for the next tick.
function startTimer(timeLeftMs) {
  maxTimeLeftMs = timeLeftMs;
  roundEndAt = Date.now() + timeLeftMs;
  // Show the timer text when a round starts
  timerTextEl.style.display = "block";
  updateTimerText();
}

// Update the timer text based on the remaining time. Formats the remaining
// time as MM:SS and hides the element when the countdown finishes.
function updateTimerText() {
  if (!maxTimeLeftMs || maxTimeLeftMs <= 0) {
    timerTextEl.style.display = "none";
    return;
  }
  const remaining = roundEndAt - Date.now();
  const clamped = Math.max(0, remaining);
  // Compute minutes and seconds
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  // Pad seconds to two digits
  const secStr = String(seconds).padStart(2, "0");
  timerTextEl.textContent = `${minutes}:${secStr}`;
  if (clamped <= 0) {
    timerTextEl.style.display = "none";
  }
}

// Regularly update the timer text to reflect the countdown.
setInterval(updateTimerText, 1000);