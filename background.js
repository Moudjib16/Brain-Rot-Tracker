/*
 * Brain Rot Tracker - background service worker.
 *
 * Statistics are stored as a per-day history under a single `stats` key:
 *
 *   { version: 2, history: { "2026-11-03": { scrolledCount, activeTimeSeconds, sites } } }
 *
 * Writes are serialized through one promise queue so two tabs syncing at the
 * same moment cannot overwrite each other. Data from version 1 (flat counters
 * plus `lastResetDate`) is migrated automatically on first read.
 */

const STORAGE_VERSION = 2;
const STATS_KEY = "stats";
const LEGACY_KEYS = ["scrolledCount", "activeTimeSeconds", "lastResetDate"];
const HISTORY_RETENTION_DAYS = 365;
const MAX_SECONDS_PER_MESSAGE = 300;
const MAX_SCROLLS_PER_MESSAGE = 50;
const SITES = ["youtube", "tiktok", "instagram"];
const MIDNIGHT_ALARM = "brt-midnight";
const BADGE_COLOR = "#ff4d4d";

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, "0");
}

function getTodayDateString(date) {
  const now = date instanceof Date ? date : new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function isValidDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseLocalDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dateStringOffset(offset, from) {
  const base = from instanceof Date ? from : new Date();
  const shifted = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
  return getTodayDateString(shifted);
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return [hours, minutes, secs].map(pad2).join(":");
}

function formatCount(value) {
  const count = Math.max(0, Math.floor(Number(value) || 0));

  if (count < 1000) {
    return String(count);
  }

  if (count < 10000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }

  return `${Math.round(count / 1000)}k`;
}

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

function emptySiteStats() {
  return { scrolledCount: 0, activeTimeSeconds: 0 };
}

function emptyDay() {
  return { scrolledCount: 0, activeTimeSeconds: 0, sites: {} };
}

function emptyStats() {
  return { version: STORAGE_VERSION, history: {} };
}

function toNonNegativeInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }
  return Math.floor(number);
}

function normalizeDay(raw) {
  const day = emptyDay();

  if (!raw || typeof raw !== "object") {
    return day;
  }

  day.scrolledCount = toNonNegativeInt(raw.scrolledCount);
  day.activeTimeSeconds = toNonNegativeInt(raw.activeTimeSeconds);

  if (raw.sites && typeof raw.sites === "object") {
    for (const site of SITES) {
      const entry = raw.sites[site];

      if (!entry || typeof entry !== "object") {
        continue;
      }

      const normalized = {
        scrolledCount: toNonNegativeInt(entry.scrolledCount),
        activeTimeSeconds: toNonNegativeInt(entry.activeTimeSeconds)
      };

      if (normalized.scrolledCount > 0 || normalized.activeTimeSeconds > 0) {
        day.sites[site] = normalized;
      }
    }
  }

  return day;
}

function pruneHistory(stats, today, retentionDays) {
  const limit = retentionDays || HISTORY_RETENTION_DAYS;
  const oldest = dateStringOffset(-(limit - 1), parseLocalDate(today || getTodayDateString()));
  const removed = [];

  for (const date of Object.keys(stats.history)) {
    if (date < oldest) {
      delete stats.history[date];
      removed.push(date);
    }
  }

  return removed;
}

function normalizeStats(raw, today) {
  const stats = emptyStats();
  const now = today || getTodayDateString();

  if (!raw || typeof raw !== "object") {
    return stats;
  }

  if (raw.history && typeof raw.history === "object") {
    for (const [date, day] of Object.entries(raw.history)) {
      if (isValidDateString(date)) {
        stats.history[date] = normalizeDay(day);
      }
    }
  }

  // Version 1 kept a single flat counter pair plus the date it belonged to.
  const legacyCount = toNonNegativeInt(raw.scrolledCount);
  const legacySeconds = toNonNegativeInt(raw.activeTimeSeconds);

  if (legacyCount > 0 || legacySeconds > 0) {
    const legacyDate = isValidDateString(raw.lastResetDate) ? raw.lastResetDate : now;
    const day = stats.history[legacyDate] || emptyDay();

    day.scrolledCount += legacyCount;
    day.activeTimeSeconds += legacySeconds;
    stats.history[legacyDate] = day;
  }

  pruneHistory(stats, now);
  return stats;
}

function getDay(stats, date) {
  return (stats.history && stats.history[date]) || emptyDay();
}

function applyActivity(stats, activity) {
  if (!stats.history[activity.date]) {
    stats.history[activity.date] = emptyDay();
  }

  const day = stats.history[activity.date];
  const scrolledCount = toNonNegativeInt(activity.scrolledCount);
  const activeTimeSeconds = toNonNegativeInt(activity.activeTimeSeconds);

  day.scrolledCount += scrolledCount;
  day.activeTimeSeconds += activeTimeSeconds;

  if (activity.site && SITES.includes(activity.site)) {
    const siteStats = day.sites[activity.site] || (day.sites[activity.site] = emptySiteStats());
    siteStats.scrolledCount += scrolledCount;
    siteStats.activeTimeSeconds += activeTimeSeconds;
  }

  return day;
}

// -----------------------------------------------------------------------------
// Toolbar badge
// -----------------------------------------------------------------------------

const lastBadge = { text: null, title: null };

function actionCall(method, details) {
  return new Promise((resolve) => {
    try {
      method.call(chrome.action, details, () => resolve());
    } catch (error) {
      resolve();
    }
  });
}

async function refreshBadge(stats) {
  if (!chrome.action) {
    return;
  }

  const today = getDay(stats, getTodayDateString());
  const text = today.scrolledCount > 0 ? formatCount(today.scrolledCount) : "";
  const title =
    today.scrolledCount === 0 && today.activeTimeSeconds === 0
      ? "Brain Rot Tracker - no activity today"
      : `Brain Rot Tracker - ${today.scrolledCount} videos, ${formatDuration(
          today.activeTimeSeconds
        )} today`;

  try {
    if (lastBadge.text !== text) {
      await actionCall(chrome.action.setBadgeText, { text });
      await actionCall(chrome.action.setBadgeBackgroundColor, { color: BADGE_COLOR });
      lastBadge.text = text;
    }

    if (lastBadge.title !== title) {
      await actionCall(chrome.action.setTitle, { title });
      lastBadge.title = title;
    }
  } catch (error) {
    // The badge is cosmetic; never let it break tracking.
    console.warn("[Brain Rot Tracker] failed to update the badge", error);
  }
}

// -----------------------------------------------------------------------------
// Storage
// -----------------------------------------------------------------------------

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function saveStats(stats) {
  return storageSet({ [STATS_KEY]: stats });
}

async function readStoredStats() {
  const data = await storageGet({
    [STATS_KEY]: null,
    scrolledCount: null,
    activeTimeSeconds: null,
    lastResetDate: null
  });

  const hadLegacyValues = LEGACY_KEYS.some(
    (key) => data[key] !== null && data[key] !== undefined
  );

  const rawStats =
    data[STATS_KEY] ||
    {
      scrolledCount: data.scrolledCount,
      activeTimeSeconds: data.activeTimeSeconds,
      lastResetDate: data.lastResetDate
    };

  const stats = normalizeStats(rawStats, getTodayDateString());
  const pruned = pruneHistory(stats, getTodayDateString());

  if (hadLegacyValues) {
    await storageRemove(LEGACY_KEYS);
  }

  if (!data[STATS_KEY] || data[STATS_KEY].version !== STORAGE_VERSION || pruned.length > 0) {
    await saveStats(stats);
  }

  return stats;
}

// Serializes every read-modify-write cycle.
let writeQueue = Promise.resolve();

function enqueue(task) {
  const result = writeQueue.then(task, task);
  writeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function withStats(mutator) {
  return enqueue(async () => {
    const stats = await readStoredStats();
    const result = await mutator(stats);
    pruneHistory(stats, getTodayDateString());
    await saveStats(stats);
    await refreshBadge(stats);
    return result === undefined ? null : result;
  });
}

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------

function validSite(value) {
  return SITES.includes(value) ? value : null;
}

function toBoundedInt(value, max) {
  const number = Math.floor(Number(value));

  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }

  return Math.min(number, max);
}

function handleMessage(message) {
  const today = getTodayDateString();

  switch (message.action) {
    case "INCREMENT_SCROLL": {
      const count = toBoundedInt(
        message.count === undefined ? 1 : message.count,
        MAX_SCROLLS_PER_MESSAGE
      );

      if (count === 0) {
        return Promise.resolve(null);
      }

      return withStats((stats) => {
        applyActivity(stats, {
          date: today,
          site: validSite(message.site),
          scrolledCount: count
        });
      });
    }

    case "ADD_ACTIVE_TIME": {
      const seconds = toBoundedInt(message.seconds, MAX_SECONDS_PER_MESSAGE);

      if (seconds === 0) {
        return Promise.resolve(null);
      }

      return withStats((stats) => {
        applyActivity(stats, {
          date: today,
          site: validSite(message.site),
          activeTimeSeconds: seconds
        });
      });
    }

    case "GET_STATS":
      return enqueue(async () => {
        const stats = await readStoredStats();
        await refreshBadge(stats);
        return stats;
      });

    case "RESET_STATS":
      return withStats((stats) => {
        delete stats.history[today];
        return stats;
      });

    default:
      return Promise.resolve(null);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== "string") {
    return false;
  }

  handleMessage(message)
    .then((stats) => sendResponse({ ok: true, stats: stats || null }))
    .catch((error) => {
      console.error("[Brain Rot Tracker] message failed", message.action, error);
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    });

  return true;
});

// -----------------------------------------------------------------------------
// Maintenance
// -----------------------------------------------------------------------------

function runMaintenance() {
  return enqueue(async () => {
    const stats = await readStoredStats();
    pruneHistory(stats, getTodayDateString());
    await saveStats(stats);
    await refreshBadge(stats);
    return stats;
  });
}

function scheduleMidnightAlarm() {
  const now = new Date();
  const nextMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    5
  );

  chrome.alarms.create(MIDNIGHT_ALARM, { when: nextMidnight.getTime() });
}

function ensureMidnightAlarm() {
  chrome.alarms.get(MIDNIGHT_ALARM, (alarm) => {
    if (!alarm) {
      scheduleMidnightAlarm();
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureMidnightAlarm();
  runMaintenance().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  ensureMidnightAlarm();
  runMaintenance().catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== MIDNIGHT_ALARM) {
    return;
  }

  scheduleMidnightAlarm();
  runMaintenance().catch(() => undefined);
});

ensureMidnightAlarm();
runMaintenance().catch(() => undefined);
