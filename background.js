const DEFAULT_STATS = {
  scrolledCount: 0,
  activeTimeSeconds: 0,
  lastResetDate: null
};

function getTodayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getStats() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_STATS, (data) => resolve(data));
  });
}

function setStats(stats) {
  return new Promise((resolve) => {
    chrome.storage.local.set(stats, () => resolve());
  });
}

async function ensureDailyReset() {
  const today = getTodayDateString();
  const stats = await getStats();

  if (stats.lastResetDate !== today) {
    const reset = {
      scrolledCount: 0,
      activeTimeSeconds: 0,
      lastResetDate: today
    };
    await setStats(reset);
    return reset;
  }

  return stats;
}

chrome.runtime.onInstalled.addListener(async () => {
  const stats = await getStats();
  const today = getTodayDateString();

  if (!stats.lastResetDate) {
    await setStats({
      scrolledCount: stats.scrolledCount ?? 0,
      activeTimeSeconds: stats.activeTimeSeconds ?? 0,
      lastResetDate: today
    });
  } else {
    await ensureDailyReset();
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureDailyReset();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== "string") {
    return false;
  }

  const handle = async () => {
    const stats = await ensureDailyReset();

    switch (message.action) {
      case "INCREMENT_SCROLL":
        return setStats({ scrolledCount: stats.scrolledCount + 1 });

      case "ADD_ACTIVE_TIME": {
        const seconds = Number(message.seconds);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return;
        }
        return setStats({ activeTimeSeconds: stats.activeTimeSeconds + Math.floor(seconds) });
      }

      case "GET_STATS":
        return stats;

      case "RESET_STATS":
        return setStats({
          scrolledCount: 0,
          activeTimeSeconds: 0,
          lastResetDate: getTodayDateString()
        });

      default:
        return undefined;
    }
  };

  handle()
    .then((result) => sendResponse({ ok: true, stats: result ?? null }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));

  return true;
});
