const chatEl = document.getElementById("chat");
const statusEl = document.getElementById("overlay-status");
const winnerEl = document.getElementById("winner");

// Elements for displaying the masked word and countdown timer. These are
// referenced later when updating the overlay during a round.
const maskedWordEl = document.getElementById("maskedWord");
const timerContainerEl = document.getElementById("timerContainer");
const timerBarEl = document.getElementById("timerBar");

// Track the maximum remaining time (ms) for the current round and the exact
// timestamp when the round should end. These values are used to animate
// the timer bar. They are reset when a new round starts or when the
// timer is adjusted via the admin panel.
let maxTimeLeftMs = 0;
let roundEndAt = 0;

let hasSecret = false;
let highlightUntil = 0;

function addMessage({ nickname, text, isCorrect }) {
  const row = document.createElement("div");
  row.className = "msg";
  const nick = document.createElement("span");
  nick.className = "nick";
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
  // Initialize the masked word display and timer based on server state
  if (state.maskedWord) {
    updateMask(state.maskedWord);
    if (typeof state.timeLeftMs === "number" && state.timeLeftMs > 0) {
      startTimer(state.timeLeftMs);
    }
  } else {
    updateMask("");
    timerContainerEl.style.display = "none";
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
    // Hide masked word and timer bar
    updateMask("");
    timerContainerEl.style.display = "none";
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
  timerContainerEl.style.display = "block";
  updateTimer();
}

// Update the width of the timer bar based on the current time. If the
// countdown finishes, hide the timer. This is called every 100ms.
function updateTimer() {
  if (!maxTimeLeftMs || maxTimeLeftMs <= 0) {
    timerContainerEl.style.display = "none";
    return;
  }
  const remaining = roundEndAt - Date.now();
  const clamped = Math.max(0, remaining);
  const pct = maxTimeLeftMs > 0 ? clamped / maxTimeLeftMs : 0;
  timerBarEl.style.width = `${pct * 100}%`;
  if (clamped <= 0) {
    timerContainerEl.style.display = "none";
  }
}

// Regularly update the timer bar to reflect the countdown.
setInterval(updateTimer, 100);