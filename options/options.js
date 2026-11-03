(function () {
  "use strict";

  const SETTINGS_KEY = BrainRotSettings.SETTINGS_KEY;
  const STATUS_VISIBLE_MS = 1600;

  const statusEl = document.getElementById("save-status");
  const toggles = Array.from(document.querySelectorAll(".switch-input[data-site]"));
  const retentionSelect = document.getElementById("history-retention");

  let statusTimer = null;

  function showStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.classList.toggle("status-error", Boolean(isError));
    statusEl.classList.add("status-visible");

    if (statusTimer) {
      clearTimeout(statusTimer);
    }

    statusTimer = setTimeout(() => {
      statusEl.classList.remove("status-visible");
      statusTimer = null;
    }, STATUS_VISIBLE_MS);
  }

  function readSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [SETTINGS_KEY]: null }, (data) => {
        if (chrome.runtime.lastError) {
          resolve(BrainRotSettings.normalizeSettings(null));
          return;
        }

        resolve(BrainRotSettings.normalizeSettings(data && data[SETTINGS_KEY]));
      });
    });
  }

  function writeSettings(settings) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [SETTINGS_KEY]: settings }, () => {
        resolve(!chrome.runtime.lastError);
      });
    });
  }

  function toRetentionValue(value) {
    const number = Number(value);

    if (!Number.isFinite(number) || number < 0) {
      return BrainRotSettings.DEFAULT_SETTINGS.historyRetentionDays;
    }

    return Math.floor(number);
  }

  async function refreshControls() {
    const settings = await readSettings();

    for (const toggle of toggles) {
      toggle.checked = settings.platforms[toggle.dataset.site] !== false;
    }

    retentionSelect.value = String(settings.historyRetentionDays);
  }

  async function save(source) {
    const settings = await readSettings();

    for (const toggle of toggles) {
      settings.platforms[toggle.dataset.site] = toggle.checked;
    }

    settings.historyRetentionDays = toRetentionValue(retentionSelect.value);

    const saved = await writeSettings(settings);

    if (saved) {
      showStatus(
        source === "retention"
          ? "Saved. Stale history beyond the new limit is pruned right away."
          : "Saved.",
        false
      );
    } else {
      showStatus("Could not save. Try again.", true);
    }
  }

  for (const toggle of toggles) {
    toggle.addEventListener("change", () => save());
  }

  retentionSelect.addEventListener("change", () => save("retention"));

  // Keep controls in sync when settings change in another tab or window.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[SETTINGS_KEY]) {
      const settings = BrainRotSettings.normalizeSettings(changes[SETTINGS_KEY].newValue);

      for (const toggle of toggles) {
        toggle.checked = settings.platforms[toggle.dataset.site] !== false;
      }

      retentionSelect.value = String(settings.historyRetentionDays);
    }
  });

  refreshControls();
})();
