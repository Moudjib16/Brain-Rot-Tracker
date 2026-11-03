const scrolledCountEl = document.getElementById("scrolled-count");
const activeTimeEl = document.getElementById("active-time");
const resetButton = document.getElementById("reset-stats");
const dateLabel = document.getElementById("date-label");
const breakdownEl = document.getElementById("breakdown");
const siteListEl = document.getElementById("site-list");
const exportCsvButton = document.getElementById("export-csv");
const exportJsonButton = document.getElementById("export-json");

const SITE_LABELS = {
  youtube: "YouTube Shorts",
  tiktok: "TikTok",
  instagram: "Instagram Reels"
};
const SITES = ["youtube", "tiktok", "instagram"];
const BREAKDOWN_DAYS = 7;

let latestStats = null;
let refreshTimer = null;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function getTodayDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function recentDates(count) {
  const now = new Date();
  const dates = [];

  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    dates.push(
      `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    );
  }

  return dates;
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
    return;
  }

  const date = getTodayDateString();

  if (format === "csv") {
    download(`brain-rot-${date}.csv`, toCsv(latestStats), "text/csv;charset=utf-8");
  } else {
    download(`brain-rot-${date}.json`, toJson(latestStats), "application/json");
  }
}

function renderBreakdown(stats) {
  const totals = {};

  for (const date of recentDates(BREAKDOWN_DAYS)) {
    const day = stats && stats.history && stats.history[date];

    if (!day || !day.sites) {
      continue;
    }

    for (const site of SITES) {
      const siteDay = day.sites[site];

      if (!siteDay) {
        continue;
      }

      const total = totals[site] || (totals[site] = { scrolledCount: 0, activeTimeSeconds: 0 });
      total.scrolledCount += siteDay.scrolledCount || 0;
      total.activeTimeSeconds += siteDay.activeTimeSeconds || 0;
    }
  }

  const rows = SITES.filter((site) => {
    const total = totals[site];
    return total && (total.scrolledCount > 0 || total.activeTimeSeconds > 0);
  });

  siteListEl.replaceChildren();
  breakdownEl.hidden = rows.length === 0;

  for (const site of rows) {
    const total = totals[site];

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

  const day = (stats && stats.history && stats.history[getTodayDateString()]) || {
    scrolledCount: 0,
    activeTimeSeconds: 0
  };

  scrolledCountEl.textContent = String(day.scrolledCount);
  activeTimeEl.textContent = formatActiveTime(day.activeTimeSeconds);

  renderBreakdown(stats);
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

exportCsvButton.addEventListener("click", () => exportData("csv"));
exportJsonButton.addEventListener("click", () => exportData("json"));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.stats) {
    scheduleRefresh();
  }
});

let displayedDate = getTodayDateString();

function updateDateLabel() {
  dateLabel.textContent = new Date().toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
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
