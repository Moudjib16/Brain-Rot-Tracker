(function () {
  "use strict";

  const SETTINGS_KEY = BrainRotSettings.SETTINGS_KEY;
  const STATUS_VISIBLE_MS = 1600;

  const statusEl = document.getElementById("save-status");
  const toggles = Array.from(document.querySelectorAll(".switch-input[data-site]"));
  const retentionSelect = document.getElementById("history-retention");
  const resetHourSelect = document.getElementById("reset-hour");
  const badgeModeSelect = document.getElementById("badge-mode");
  const debugToggle = document.getElementById("debug-logging");
  const reduceMotionToggle = document.getElementById("reduce-motion");

  function applyMotionSetting(settings) {
    document.documentElement.classList.toggle(
      "reduce-motion",
      Boolean(settings && settings.reduceMotion)
    );
  }

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

  function toHourValue(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return BrainRotSettings.DEFAULT_SETTINGS.resetHour;
    }

    return Math.min(23, Math.max(0, Math.floor(number)));
  }

  function ensureOptionPresent(select, value) {
    const exists = Array.from(select.options).some((option) => option.value === value);

    if (!exists) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `${String(value).padStart(2, "0")}:00`;
      select.append(option);
    }
  }

  function toBadgeModeValue(value) {
    return ["count", "time", "none"].includes(value)
      ? value
      : BrainRotSettings.DEFAULT_SETTINGS.badgeMode;
  }

  async function refreshControls() {
    const settings = await readSettings();

    for (const toggle of toggles) {
      toggle.checked = settings.platforms[toggle.dataset.site] !== false;
    }

    ensureOptionPresent(resetHourSelect, String(settings.resetHour));
    retentionSelect.value = String(settings.historyRetentionDays);
    resetHourSelect.value = String(settings.resetHour);
    badgeModeSelect.value = settings.badgeMode;
    debugToggle.checked = settings.debugLogging !== false;
    reduceMotionToggle.checked = settings.reduceMotion === true;
    applyMotionSetting(settings);
  }

  async function save(source) {
    const settings = await readSettings();

    for (const toggle of toggles) {
      settings.platforms[toggle.dataset.site] = toggle.checked;
    }

    settings.historyRetentionDays = toRetentionValue(retentionSelect.value);
    settings.resetHour = toHourValue(resetHourSelect.value);
    settings.badgeMode = toBadgeModeValue(badgeModeSelect.value);
    settings.debugLogging = debugToggle.checked;
    settings.reduceMotion = reduceMotionToggle.checked;

    const saved = await writeSettings(settings);
    applyMotionSetting(settings);

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
  resetHourSelect.addEventListener("change", () => save());
  badgeModeSelect.addEventListener("change", () => save());
  debugToggle.addEventListener("change", () => save());
  reduceMotionToggle.addEventListener("change", () => save());

  // Keep controls in sync when settings change in another tab or window.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[SETTINGS_KEY]) {
      const settings = BrainRotSettings.normalizeSettings(changes[SETTINGS_KEY].newValue);

      for (const toggle of toggles) {
        toggle.checked = settings.platforms[toggle.dataset.site] !== false;
      }

      ensureOptionPresent(resetHourSelect, String(settings.resetHour));
      retentionSelect.value = String(settings.historyRetentionDays);
      resetHourSelect.value = String(settings.resetHour);
      badgeModeSelect.value = settings.badgeMode;
      debugToggle.checked = settings.debugLogging !== false;
      reduceMotionToggle.checked = settings.reduceMotion === true;
      applyMotionSetting(settings);
    }
  });

  refreshControls();
})();
