/*
 * Brain Rot Tracker - shared settings schema.
 *
 * Loaded before content.js and background.js, and by the options page, so all
 * surfaces agree on the shape, defaults, and normalization of the `settings`
 * key in chrome.storage.local.
 *
 *   {
 *     platforms: { youtube: true, tiktok: true, instagram: true },
 *     historyRetentionDays: 365,   // 0 keeps history forever
 *     debugLogging: true,
 *     resetHour: 0                 // hour of day the tracking day starts
 *   }
 */
(function (root) {
  "use strict";

  const SETTINGS_KEY = "settings";
  const KNOWN_SITES = ["youtube", "tiktok", "instagram"];

  const DEFAULT_SETTINGS = {
    platforms: { youtube: true, tiktok: true, instagram: true },
    historyRetentionDays: 365,
    debugLogging: true,
    resetHour: 0
  };

  function toNonNegativeInt(value, fallback) {
    const number = Number(value);

    if (!Number.isFinite(number) || number < 0) {
      return fallback;
    }

    return Math.floor(number);
  }

  function toHourValue(value, fallback) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return fallback;
    }

    return Math.min(23, Math.max(0, Math.floor(number)));
  }

  function normalizeSettings(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const sourcePlatforms =
      source.platforms && typeof source.platforms === "object" ? source.platforms : {};

    const platforms = {};

    for (const site of KNOWN_SITES) {
      platforms[site] =
        typeof sourcePlatforms[site] === "boolean"
          ? sourcePlatforms[site]
          : DEFAULT_SETTINGS.platforms[site];
    }

    return {
      platforms,
      historyRetentionDays: toNonNegativeInt(
        source.historyRetentionDays,
        DEFAULT_SETTINGS.historyRetentionDays
      ),
      debugLogging:
        typeof source.debugLogging === "boolean"
          ? source.debugLogging
          : DEFAULT_SETTINGS.debugLogging,
      resetHour: toHourValue(source.resetHour, DEFAULT_SETTINGS.resetHour)
    };
  }

  function isPlatformEnabled(settings, site) {
    const normalized = normalizeSettings(settings);
    return Boolean(normalized.platforms[site]);
  }

  root.BrainRotSettings = {
    SETTINGS_KEY,
    KNOWN_SITES,
    DEFAULT_SETTINGS,
    normalizeSettings,
    isPlatformEnabled
  };
})(typeof self !== "undefined" ? self : globalThis);
