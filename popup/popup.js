const scrolledCountEl = document.getElementById("scrolled-count");
const activeTimeEl = document.getElementById("active-time");
const resetButton = document.getElementById("reset-stats");
const dateLabel = document.getElementById("date-label");
const breakdownEl = document.getElementById("breakdown");
const siteListEl = document.getElementById("site-list");
const weekChartEl = document.getElementById("week-chart");
const weekSummaryEl = document.getElementById("week-summary");
const streakEl = document.getElementById("streak");
const toastEl = document.getElementById("toast");
const toastMessageEl = document.getElementById("toast-message");
const toastActionEl = document.getElementById("toast-action");
const exportCsvButton = document.getElementById("export-csv");
const exportJsonButton = document.getElementById("export-json");

const SITE_LABELS = {
  youtube: "YouTube Shorts",
  tiktok: "TikTok",
  instagram: "Instagram Reels"
};
const SITES = ["youtube", "tiktok", "instagram"];
const WEEK_LENGTH = 7;
const UNDO_WINDOW_MS = 8000;
const STREAK_LIMIT = 365;

let latestStats = null;
let refreshTimer = null;
let toastTimer = null;
let displayedDate = getTodayDateString();

// -----------------------------------------------------------------------------
// Dates and formatting
// -----------------------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, "0");
}

function getTodayDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function parseLocalDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dateStringOffset(offset, from) {
  const base = from instanceof Date ? from : new Date();
  const shifted = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
  return `${shifted.getFullYear()}-${pad2(shifted.getMonth() + 1)}-${pad2(
    shifted.getDate()
  )}`;
}

function recentDates(count) {
  const dates = [];

  for (let offset = count - 1; offset >= 0; offset -= 1) {
    dates.push(dateStringOffset(-offset));
  }

  return dates;
}

function formatActiveTime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return [hours, minutes, secs].map(pad2).join(":");
}

function formatCompactDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${pad2(minutes)}m`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return `${seconds}s`;
}

function formatWeekday(dateString) {
  return parseLocalDate(dateString).toLocaleDateString(undefined, {
    weekday: "narrow"
  });
}

function formatFullDate(dateString) {
  return parseLocalDate(dateString).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
}

// -----------------------------------------------------------------------------
// Data helpers
// -----------------------------------------------------------------------------

function getDay(stats, date) {
  return (stats && stats.history && stats.history[date]) || {
    scrolledCount: 0,
    activeTimeSeconds: 0,
    sites: {}
  };
}

function isDayEmpty(day) {
  return !day || (day.scrolledCount === 0 && day.activeTimeSeconds === 0);
}

function sumDays(stats, dates) {
  const total = { scrolledCount: 0, activeTimeSeconds: 0, sites: {} };

  for (const date of dates) {
    const day = getDay(stats, date);
    total.scrolledCount += day.scrolledCount || 0;
    total.activeTimeSeconds += day.activeTimeSeconds || 0;

    for (const site of SITES) {
      const siteDay = day.sites && day.sites[site];

      if (!siteDay) {
        continue;
      }

      const siteTotal =
        total.sites[site] ||
        (total.sites[site] = { scrolledCount: 0, activeTimeSeconds: 0 });
      siteTotal.scrolledCount += siteDay.scrolledCount || 0;
      siteTotal.activeTimeSeconds += siteDay.activeTimeSeconds || 0;
    }
  }

  return total;
}

/**
 * Consecutive days with activity, counting backwards from today. If today is
 * still empty the streak is measured up to yesterday so it does not appear
 * broken first thing in the morning.
 */
function currentStreak(stats) {
  const today = getTodayDateString();
  let cursor = today;

  if (isDayEmpty(getDay(stats, cursor))) {
    cursor = dateStringOffset(-1, parseLocalDate(today));
  }

  let streak = 0;

  while (streak <= STREAK_LIMIT && !isDayEmpty(getDay(stats, cursor))) {
    streak += 1;
    cursor = dateStringOffset(-1, parseLocalDate(cursor));
  }

  return streak;
}

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------

function send(action, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...(payload || {}) }, (response) => {
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

// -----------------------------------------------------------------------------
// Toast
// -----------------------------------------------------------------------------

function hideToast() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }

  toastEl.hidden = true;
  toastEl.classList.remove("toast-error");
  toastActionEl.hidden = true;
  toastActionEl.onclick = null;
}

function showToast(message, options) {
  const { actionLabel, onAction, tone, timeout } = options || {};

  hideToast();
  toastMessageEl.textContent = message;
  toastEl.classList.toggle("toast-error", tone === "error");
  toastEl.hidden = false;

  if (actionLabel && onAction) {
    toastActionEl.textContent = actionLabel;
    toastActionEl.hidden = false;
    toastActionEl.onclick = () => {
      hideToast();
      onAction();
    };
  }

  toastTimer = setTimeout(hideToast, timeout || UNDO_WINDOW_MS);
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

function renderWeekChart(stats, dates) {
  const days = dates.map((date) => getDay(stats, date));
  const maxCount = Math.max(1, ...days.map((day) => day.scrolledCount));
  const today = getTodayDateString();

  weekChartEl.replaceChildren();

  dates.forEach((date, index) => {
    const day = days[index];
    const description = `${formatFullDate(date)}: ${day.scrolledCount} videos, ${formatActiveTime(
      day.activeTimeSeconds
    )}`;

    const item = document.createElement("li");
    item.className = "chart-day";

    if (date === today) {
      item.classList.add("chart-day-today");
    }

    const track = document.createElement("div");
    track.className = "chart-track";

    const bar = document.createElement("div");
    bar.className = "chart-bar";
    bar.style.setProperty("--ratio", String(day.scrolledCount / maxCount));
    bar.title = description;

    const label = document.createElement("span");
    label.className = "chart-label";
    label.textContent = formatWeekday(date);
    label.setAttribute("aria-hidden", "true");

    item.setAttribute("aria-label", description);
    track.append(bar);
    item.append(track, label);
    weekChartEl.append(item);
  });

  const total = sumDays(stats, dates);
  weekSummaryEl.textContent = `${total.scrolledCount} videos · ${formatCompactDuration(
    total.activeTimeSeconds
  )}`;
}

function renderBreakdown(stats, dates) {
  const totals = sumDays(stats, dates);
  const rows = SITES.filter((site) => {
    const total = totals.sites[site];
    return total && (total.scrolledCount > 0 || total.activeTimeSeconds > 0);
  });

  siteListEl.replaceChildren();
  breakdownEl.hidden = rows.length === 0;

  for (const site of rows) {
    const total = totals.sites[site];

    const item = document.createElement("li");
    item.className = "site-row";

    const name = document.createElement("span");
    name.className = "site-name";
    name.textContent = SITE_LABELS[site];

    const value = document.createElement("span");
    value.className = "site-value";
    value.textContent = `${total.scrolledCount} · ${formatCompactDuration(
      total.activeTimeSeconds
    )}`;

    item.append(name, value);
    siteListEl.append(item);
  }
}

function renderStats(stats) {
  latestStats = stats;

  const today = getDay(stats, getTodayDateString());
  const dates = recentDates(WEEK_LENGTH);

  scrolledCountEl.textContent = String(today.scrolledCount);
  activeTimeEl.textContent = formatActiveTime(today.activeTimeSeconds);

  renderWeekChart(stats, dates);
  renderBreakdown(stats, dates);

  const streak = currentStreak(stats);

  if (streak >= 2) {
    streakEl.hidden = false;
    streakEl.textContent = `${streak}-day streak`;
  } else {
    streakEl.hidden = true;
  }
}

// -----------------------------------------------------------------------------
// Data loading
// -----------------------------------------------------------------------------

async function loadStats() {
  try {
    const stats = await send("GET_STATS");
    renderStats(stats);
  } catch (error) {
    showToast(`Could not load stats: ${error.message}`, { tone: "error" });
  }
}

function scheduleRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(loadStats, 100);
}

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

async function undoReset(snapshot) {
  try {
    const stats = await send("RESTORE_STATS", { day: snapshot });
    renderStats(stats);
    showToast("Stats restored.");
  } catch (error) {
    showToast(`Could not restore stats: ${error.message}`, { tone: "error" });
  }
}

resetButton.addEventListener("click", async () => {
  if (!latestStats) {
    return;
  }

  const snapshot = JSON.parse(
    JSON.stringify(getDay(latestStats, getTodayDateString()))
  );

  resetButton.disabled = true;

  try {
    const stats = await send("RESET_STATS");
    renderStats(stats);
    showToast("Today's stats reset.", {
      actionLabel: "Undo",
      onAction: () => undoReset(snapshot)
    });
  } catch (error) {
    showToast(`Could not reset stats: ${error.message}`, { tone: "error" });
  } finally {
    resetButton.disabled = false;
  }
});

// -----------------------------------------------------------------------------
// Export
// -----------------------------------------------------------------------------

const CSV_COLUMNS = ["date", "scrolled_count", "active_time_seconds", "active_time_hhmmss"];

for (const site of SITES) {
  CSV_COLUMNS.push(`${site}_scrolled`, `${site}_active_time_seconds`);
}

function daysWithActivity(stats) {
  return Object.entries((stats && stats.history) || {})
    .filter(([, day]) => day && (day.scrolledCount > 0 || day.activeTimeSeconds > 0))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function toCsv(stats) {
  const lines = [CSV_COLUMNS.join(",")];

  for (const [date, day] of daysWithActivity(stats)) {
    const row = [
      date,
      day.scrolledCount,
      day.activeTimeSeconds,
      formatActiveTime(day.activeTimeSeconds)
    ];

    for (const site of SITES) {
      const siteDay = (day.sites && day.sites[site]) || {
        scrolledCount: 0,
        activeTimeSeconds: 0
      };
      row.push(siteDay.scrolledCount, siteDay.activeTimeSeconds);
    }

    lines.push(row.join(","));
  }

  // Byte-order mark so spreadsheet apps detect UTF-8.
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function toJson(stats) {
  return JSON.stringify(
    {
      extension: "Brain Rot Tracker",
      version: (stats && stats.version) || 2,
      exportedAt: new Date().toISOString(),
      history: (stats && stats.history) || {}
    },
    null,
    2
  );
}

function download(filename, contents, mimeType) {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportData(format) {
  if (!latestStats) {
    showToast("Stats are still loading.", { tone: "error" });
    return;
  }

  const date = getTodayDateString();

  if (format === "csv") {
    download(`brain-rot-${date}.csv`, toCsv(latestStats), "text/csv;charset=utf-8");
  } else {
    download(`brain-rot-${date}.json`, toJson(latestStats), "application/json");
  }

  showToast(`Exported ${format.toUpperCase()} for ${formatFullDate(date)}.`);
}

exportCsvButton.addEventListener("click", () => exportData("csv"));
exportJsonButton.addEventListener("click", () => exportData("json"));

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

document.getElementById("open-settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.stats) {
    scheduleRefresh();
  }
});

function updateDateLabel() {
  dateLabel.textContent = `${formatFullDate(getTodayDateString())} · today`;
}

function checkDateRollover() {
  const today = getTodayDateString();

  if (today !== displayedDate) {
    displayedDate = today;
    updateDateLabel();
    loadStats();
  }
}

updateDateLabel();
loadStats();
setInterval(checkDateRollover, 60000);
