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
 *
 * Settings are shared with the content script and options page through
 * settings.js, stored under the `settings` key in chrome.storage.local.
 */

if (typeof BrainRotSettings === "undefined" && typeof importScripts === "function") {
  importScripts("settings.js");
}

if (typeof BrainRotSettings === "undefined") {
  // Defensive fallback so the worker never hard-fails if settings.js is missing.
  globalThis.BrainRotSettings = {
    SETTINGS_KEY: "settings",
    normalizeSettings(raw) {
      const source = raw && typeof raw === "object" ? raw : {};
      const platforms = { youtube: true, tiktok: true, instagram: true };

      if (source.platforms && typeof source.platforms === "object") {
        for (const site of Object.keys(platforms)) {
          if (typeof source.platforms[site] === "boolean") {
            platforms[site] = source.platforms[site];
          }
        }
      }

      const retention = Number(source.historyRetentionDays);
      const resetHour = Number(source.resetHour);
      return {
        platforms,
        historyRetentionDays:
          Number.isFinite(retention) && retention >= 0 ? Math.floor(retention) : 365,
        debugLogging: source.debugLogging !== false,
        resetHour: Number.isFinite(resetHour) ? Math.min(23, Math.max(0, Math.floor(resetHour))) : 0,
        badgeMode: ["count", "time", "none"].includes(source.badgeMode) ? source.badgeMode : "count",
        trackAllPlatformTime: source.trackAllPlatformTime === true
      };
    }
  };
}

const STORAGE_VERSION = 2;
const STATS_KEY = "stats";
const LEGACY_KEYS = ["scrolledCount", "activeTimeSeconds", "lastResetDate"];
const HISTORY_RETENTION_DAYS = 365;
const MAX_SECONDS_PER_MESSAGE = 300;
const MAX_SCROLLS_PER_MESSAGE = 50;
const SITES = ["youtube", "tiktok", "instagram"];
const MIDNIGHT_ALARM = "brt-midnight"; // legacy name, cleared on load
const ROLLOVER_ALARM = "brt-rollover";
const BADGE_COLOR = "#ff4d4d";
const SETTINGS_KEY = BrainRotSettings.SETTINGS_KEY;

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toResetHour(value) {
  const hour = Number(value);

  if (!Number.isFinite(hour)) {
    return 0;
  }

  return Math.min(23, Math.max(0, Math.floor(hour)));
}

function getTodayDateString(date, resetHour) {
  const now = date instanceof Date ? date : new Date();
  const hour = toResetHour(resetHour);

  // The tracking day starts at the configured hour, not at midnight. Before
  // that hour the "current" day is still the previous calendar date.
  const base =
    now.getHours() < hour
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      : now;

  return `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())}`;
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
  const limit = retentionDays === undefined ? HISTORY_RETENTION_DAYS : retentionDays;

  // A retention of 0 means keep the full history.
  if (limit <= 0) {
    return [];
  }

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

function normalizeStats(raw, today, retentionDays) {
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

  pruneHistory(stats, now, retentionDays);
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

function formatBadgeDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return minutes > 0 ? `${hours}h${pad2(minutes)}` : `${hours}h`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  if (seconds > 0) {
    return `${seconds}s`;
  }

  return "";
}

async function refreshBadge(stats) {
  if (!chrome.action) {
    return;
  }

  const mode = ["count", "time", "none"].includes(currentBadgeMode)
    ? currentBadgeMode
    : "count";
  const today = getDay(stats, getTodayDateString(undefined, currentResetHour));

  let text;
  let title;

  if (mode === "none") {
    text = "";
    title = "Brain Rot Tracker";
  } else if (mode === "time") {
    text = formatBadgeDuration(today.activeTimeSeconds);
    title =
      today.scrolledCount === 0 && today.activeTimeSeconds === 0
        ? "Brain Rot Tracker - no activity today"
        : `Brain Rot Tracker - ${today.scrolledCount} videos, ${formatDuration(
            today.activeTimeSeconds
          )} today`;
  } else {
    text = today.scrolledCount > 0 ? formatCount(today.scrolledCount) : "";
    title =
      today.scrolledCount === 0 && today.activeTimeSeconds === 0
        ? "Brain Rot Tracker - no activity today"
        : `Brain Rot Tracker - ${today.scrolledCount} videos, ${formatDuration(
            today.activeTimeSeconds
          )} today`;
  }

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
    lastResetDate: null,
    [SETTINGS_KEY]: null
  });

  const settings = BrainRotSettings.normalizeSettings(data[SETTINGS_KEY]);
  const retention = settings.historyRetentionDays;
  const resetHour = toResetHour(settings.resetHour);
  const badgeMode = ["count", "time", "none"].includes(settings.badgeMode)
    ? settings.badgeMode
    : "count";
  lastRetentionDays = retention;
  currentResetHour = resetHour;
  currentBadgeMode = badgeMode;
  const nowKey = getTodayDateString(undefined, resetHour);

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

  const stats = normalizeStats(rawStats, nowKey, retention);
  const pruned = pruneHistory(stats, nowKey, retention);

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

// Retention from the most recent read; keeps withStats pruning in step with
// the settings that were just loaded. Only mutated inside the serialized queue.
let lastRetentionDays = HISTORY_RETENTION_DAYS;
let currentResetHour = 0;
let currentBadgeMode = "count";

function readSettings() {
  return storageGet({ [SETTINGS_KEY]: null }).then((data) =>
    BrainRotSettings.normalizeSettings(data[SETTINGS_KEY])
  );
}

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
    pruneHistory(stats, getTodayDateString(undefined, currentResetHour), lastRetentionDays);
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

async function handleMessage(message) {
  const settings = await readSettings();
  const today = getTodayDateString(undefined, toResetHour(settings.resetHour));

  switch (message.action) {
    case "INCREMENT_SCROLL": {
      const count = toBoundedInt(
        message.count === undefined ? 1 : message.count,
        MAX_SCROLLS_PER_MESSAGE
      );

      if (count === 0) {
        return Promise.resolve(null);
      }

      const site = validSite(message.site);

      // A known platform that is switched off is ignored entirely, even for
      // the grand total. Unknown sites keep the previous behavior.
      if (site && settings.platforms[site] === false) {
        return null;
      }

      return withStats((stats) => {
        applyActivity(stats, { date: today, site, scrolledCount: count });
      });
    }

    case "ADD_ACTIVE_TIME": {
      const seconds = toBoundedInt(message.seconds, MAX_SECONDS_PER_MESSAGE);

      if (seconds === 0) {
        return Promise.resolve(null);
      }

      const site = validSite(message.site);

      if (site && settings.platforms[site] === false) {
        return null;
      }

      return withStats((stats) => {
        applyActivity(stats, { date: today, site, activeTimeSeconds: seconds });
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

    case "RESTORE_STATS": {
      const snapshot = normalizeDay(message.day);

      return withStats((stats) => {
        const day = stats.history[today] || emptyDay();
        stats.history[today] = day;

        day.scrolledCount += snapshot.scrolledCount;
        day.activeTimeSeconds += snapshot.activeTimeSeconds;

        for (const site of SITES) {
          const siteStats = snapshot.sites[site];

          if (!siteStats) {
            continue;
          }

          const current = day.sites[site] || (day.sites[site] = emptySiteStats());
          current.scrolledCount += siteStats.scrolledCount;
          current.activeTimeSeconds += siteStats.activeTimeSeconds;
        }

        return stats;
      });
    }

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
    pruneHistory(stats, getTodayDateString(undefined, currentResetHour), lastRetentionDays);
    await saveStats(stats);
    await refreshBadge(stats);
    return stats;
  });
}

// Re-prune and reschedule the rollover as soon as the settings change so a
// shorter retention or a new rollover hour takes effect right away instead of
// waiting for the next maintenance run.
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[SETTINGS_KEY]) {
      scheduleRolloverAlarmFromSettings();
      runMaintenance().catch(() => undefined);
    }
  });
}

function scheduleRolloverAlarm(resetHour) {
  const hour = toResetHour(resetHour);
  const now = new Date();
  let when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 5);

  if (when.getTime() <= now.getTime()) {
    when = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, 0, 5);
  }

  try {
    chrome.alarms.clear(ROLLOVER_ALARM, () => {
      chrome.alarms.create(ROLLOVER_ALARM, { when: when.getTime() });
    });
  } catch (error) {
    console.warn("[Brain Rot Tracker] failed to schedule the rollover alarm", error);
  }
}

function scheduleRolloverAlarmFromSettings() {
  readSettings()
    .then((settings) => scheduleRolloverAlarm(settings.resetHour))
    .catch(() => scheduleRolloverAlarm(0));
}

function ensureRolloverAlarm() {
  chrome.alarms.get(ROLLOVER_ALARM, (alarm) => {
    if (!alarm) {
      scheduleRolloverAlarmFromSettings();
    }
  });

  // Clean up the alarm from versions that only rolled over at midnight.
  try {
    chrome.alarms.clear(MIDNIGHT_ALARM, () => undefined);
  } catch (error) {
    // Nothing to clean up.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureRolloverAlarm();
  runMaintenance().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  ensureRolloverAlarm();
  runMaintenance().catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ROLLOVER_ALARM) {
    return;
  }

  scheduleRolloverAlarmFromSettings();
  runMaintenance().catch(() => undefined);
});

ensureRolloverAlarm();
runMaintenance().catch(() => undefined);
