const scrolledCountEl = document.getElementById("scrolled-count");
const activeTimeEl = document.getElementById("active-time");
const resetButton = document.getElementById("reset-stats");
const dateLabel = document.getElementById("date-label");

let refreshTimer = null;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function getTodayDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function formatActiveTime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return [hours, minutes, secs].map(pad2).join(":");
}

function send(action) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response || response.ok !== true) {
        reject(new Error((response && response.error) || "Unknown extension error"));
        return;
      }

      resolve(response.stats);
    });
  });
}

function renderStats(stats) {
  const day = (stats && stats.history && stats.history[getTodayDateString()]) || {
    scrolledCount: 0,
    activeTimeSeconds: 0
  };

  scrolledCountEl.textContent = String(day.scrolledCount);
  activeTimeEl.textContent = formatActiveTime(day.activeTimeSeconds);
}

async function loadStats() {
  try {
    const stats = await send("GET_STATS");
    renderStats(stats);
  } catch (error) {
    console.error("[Brain Rot Tracker] could not load stats", error);
  }
}

function scheduleRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(loadStats, 100);
}

resetButton.addEventListener("click", async () => {
  resetButton.disabled = true;

  try {
    const stats = await send("RESET_STATS");
    renderStats(stats);
  } catch (error) {
    console.error("[Brain Rot Tracker] could not reset stats", error);
  } finally {
    resetButton.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.stats) {
    scheduleRefresh();
  }
});

dateLabel.textContent = new Date().toLocaleDateString(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric"
});

loadStats();
