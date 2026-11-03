const DEFAULT_STATS = {
  scrolledCount: 0,
  activeTimeSeconds: 0,
  lastResetDate: null
};

const scrolledCountEl = document.getElementById("scrolled-count");
const activeTimeEl = document.getElementById("active-time");
const resetButton = document.getElementById("reset-stats");
const dateLabel = document.getElementById("date-label");

function getTodayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatActiveTime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return [hours, minutes, secs].map((unit) => String(unit).padStart(2, "0")).join(":");
}

function renderStats(stats) {
  scrolledCountEl.textContent = String(stats.scrolledCount ?? 0);
  activeTimeEl.textContent = formatActiveTime(stats.activeTimeSeconds ?? 0);
}

async function getStats() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_STATS, (data) => resolve(data));
  });
}

async function resetStats() {
  const today = getTodayDateString();
  await new Promise((resolve) => {
    chrome.storage.local.set(
      { scrolledCount: 0, activeTimeSeconds: 0, lastResetDate: today },
      () => resolve()
    );
  });
}

async function loadStats() {
  const stats = await getStats();
  const today = getTodayDateString();

  if (stats.lastResetDate !== today) {
    await resetStats();
    renderStats({ scrolledCount: 0, activeTimeSeconds: 0 });
    return;
  }

  renderStats(stats);
}

resetButton.addEventListener("click", async () => {
  await resetStats();
  renderStats({ scrolledCount: 0, activeTimeSeconds: 0 });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  chrome.storage.local.get(DEFAULT_STATS, (stats) => {
    renderStats(stats);
  });
});

dateLabel.textContent = new Date().toLocaleDateString(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric"
});

loadStats();
