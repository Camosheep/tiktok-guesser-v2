async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

async function refreshState() {
  const res = await fetch("/api/state");
  const json = await res.json();
  const s = document.getElementById("state");
  s.textContent =
    `Room: ${json.connectedRoom || "-"} | Running: ${json.isRunning ? "Yes" : "No"} | Secret set: ${json.secretSet ? "Yes" : "No"} | Winner: ${json.winner ? json.winner.nickname : "-"}`;
}

function toast(msg, ok = true) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.style.color = ok ? "#8fffa0" : "#ff6a6a";
  setTimeout(() => (t.textContent = ""), 2500);
}

document.getElementById("start").onclick = async () => {
  try {
    const room = document.getElementById("room").value.trim();
    if (!room) return toast("Enter a TikTok username first", false);
    await api("/api/start", { room });
    toast("Connected!");
    refreshState();
  } catch (e) {
    toast(String(e.message || e), false);
  }
};

document.getElementById("stop").onclick = async () => {
  try {
    await api("/api/stop");
    toast("Disconnected.");
    refreshState();
  } catch (e) {
    toast(String(e.message || e), false);
  }
};

document.getElementById("setword").onclick = async () => {
  try {
    const word = document.getElementById("word").value.trim();
    if (!word) return toast("Enter a word/phrase first", false);
    await api("/api/set-word", { word });
    toast("Round started.");
    refreshState();
  } catch (e) {
    toast(String(e.message || e), false);
  }
};

document.getElementById("reset").onclick = async () => {
  try {
    await api("/api/reset-round");
    toast("Round reset.");
    refreshState();
  } catch (e) {
    toast(String(e.message || e), false);
  }
};

// Handle start reading words: call /api/start-reading to resume judging guesses
document.getElementById("startReading").onclick = async () => {
  try {
    await api("/api/start-reading");
    toast("Started reading guesses.");
    refreshState();
  } catch (e) {
    // If the API returns an error (e.g. no secret set), surface it to the user
    toast(String(e.message || e), false);
  }
};

// Handle stop reading words: call /api/stop-reading to pause judging guesses
document.getElementById("stopReading").onclick = async () => {
  try {
    await api("/api/stop-reading");
    toast("Stopped reading guesses.");
    refreshState();
  } catch (e) {
    toast(String(e.message || e), false);
  }
};

// Handle setting the remaining timer for the current round. Reads the value
// (in seconds) from the timerSeconds input and sends it to the server. If
// invalid or missing, surface an error to the admin. After updating,
// refresh the state so the UI can reflect any changes.
document.getElementById("setTimer").onclick = async () => {
  try {
    const secondsStr = document.getElementById("timerSeconds").value.trim();
    const seconds = Number(secondsStr);
    if (!seconds || isNaN(seconds) || seconds <= 0) {
      return toast("Enter a valid number of seconds", false);
    }
    await api("/api/update-timer", { seconds });
    toast(`Timer set to ${seconds} seconds.`);
    refreshState();
  } catch (e) {
    toast(String(e.message || e), false);
  }
};

// Handle revealing specific letter positions. Reads positions from the
// revealPositions input and calls the API. Positions should be entered as
// 1-based indices separated by semicolons or commas. After updating,
// refresh the state.
document.getElementById("revealLetters").onclick = async () => {
  try {
    const positions = document.getElementById("revealPositions").value.trim();
    if (!positions) return toast("Enter letter positions to reveal", false);
    await api("/api/reveal-letters", { positions });
    toast("Selected letters revealed.");
    refreshState();
  } catch (e) {
    toast(String(e.message || e), false);
  }
};

// Handle revealing the entire word. Invokes the reveal-word API. After
// completing, refresh the state so that maskedWord is fully visible.
document.getElementById("revealWord").onclick = async () => {
  try {
    await api("/api/reveal-word");
    toast("Word revealed.");
    refreshState();
  } catch (e) {
    toast(String(e.message || e), false);
  }
};

refreshState();
setInterval(refreshState, 3000);