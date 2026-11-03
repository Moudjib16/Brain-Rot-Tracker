(function () {
  "use strict";

  const SYNC_INTERVAL_SECONDS = 1;

  if (typeof BrainRotSettings === "undefined") {
    // Content scripts are declared with settings.js first; this is a
    // defensive fallback so the tracker never hard-fails.
    globalThis.BrainRotSettings = {
      SETTINGS_KEY: "settings",
      normalizeSettings() {
        return {
          platforms: { youtube: true, tiktok: true, instagram: true },
          historyRetentionDays: 365,
          debugLogging: true
        };
      }
    };
  }

  let currentSettings = BrainRotSettings.normalizeSettings(null);

  function applySettings(raw) {
    currentSettings = BrainRotSettings.normalizeSettings(raw);
  }

  function isSiteEnabled(siteName) {
    if (!siteName) {
      return true;
    }

    return currentSettings.platforms[siteName] !== false;
  }

  function debugLog() {
    if (!currentSettings.debugLogging) {
      return;
    }

    console.debug.apply(console, arguments);
  }

  try {
    chrome.storage.local.get({ [BrainRotSettings.SETTINGS_KEY]: null }, (data) => {
      if (chrome.runtime.lastError) {
        return;
      }

      applySettings(data && data[BrainRotSettings.SETTINGS_KEY]);
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }

      const change = changes[BrainRotSettings.SETTINGS_KEY];

      if (change) {
        applySettings(change.newValue);
      }
    });
  } catch (error) {
    // Storage APIs unavailable; defaults keep tracking enabled.
  }

  let unsyncedSeconds = 0;

  function isUserActive() {
    // Opening an extension popup blurs the page even though the user is still
    // actively viewing that tab. Page visibility is the reliable signal here:
    // it becomes hidden when the user switches tabs, minimizes the window, or
    // locks the screen, but stays visible while the popup is open.
    return document.visibilityState === "visible";
  }

  function tick() {
    if (isUserActive() && isSiteEnabled(site)) {
      unsyncedSeconds += 1;

      if (unsyncedSeconds >= SYNC_INTERVAL_SECONDS) {
        flushActiveTime();
      }
    }
  }

  function flushActiveTime() {
    if (unsyncedSeconds <= 0) {
      return;
    }

    if (!isSiteEnabled(site)) {
      unsyncedSeconds = 0;
      return;
    }

    const secondsToSend = unsyncedSeconds;
    unsyncedSeconds = 0;

    try {
      chrome.runtime.sendMessage(
        { action: "ADD_ACTIVE_TIME", seconds: secondsToSend, site },
        () => {
          if (chrome.runtime.lastError) {
            unsyncedSeconds += secondsToSend;
          }
        }
      );
    } catch (error) {
      unsyncedSeconds += secondsToSend;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      flushActiveTime();
    }
  });

  window.addEventListener("pagehide", flushActiveTime);
  window.addEventListener("beforeunload", flushActiveTime);

  const SITE_CONFIG = [
    {
      site: "youtube",
      match: /(^|\.)youtube\.com$/,
      selectors: ["ytd-reel-video-renderer"]
    },
    {
      site: "tiktok",
      match: /(^|\.)tiktok\.com$/,
      selectors: ['[data-e2e="recommend-list-item-container"]', "video"]
    },
    {
      // Instagram's reel markup changes frequently. Observing the video itself
      // works for the feed, full-screen reels, and modal reels, unlike
      // observing an article wrapper that often never reaches the threshold.
      site: "instagram",
      match: /(^|\.)instagram\.com$/,
      selectors: ["video"]
    }
  ];

  const hostname = window.location.hostname;
  const matchedSite = SITE_CONFIG.find((entry) => entry.match.test(hostname)) || null;
  const site = matchedSite ? matchedSite.site : null;
  const domainSelectors = matchedSite
    ? matchedSite.selectors
    : SITE_CONFIG.flatMap((entry) => entry.selectors);

  const observedElements = new WeakSet();
  const MIN_VISIBLE_MS = 700;
  const IDENTITY_CACHE_LIMIT = 300;
  const latestVisibility = new WeakMap();
  const pendingTimers = new WeakMap();
  const countedIdentities = new Set();

  function rememberIdentity(identity) {
    countedIdentities.add(identity);

    if (countedIdentities.size > IDENTITY_CACHE_LIMIT) {
      const oldest = countedIdentities.values().next().value;
      countedIdentities.delete(oldest);
    }
  }

  function getVideoIdentity(element) {
    const shortsMatch = window.location.pathname.match(/\/shorts\/([^/?#]+)/);

    if (shortsMatch) {
      return `short:${shortsMatch[1]}`;
    }

    const video =
      element instanceof HTMLVideoElement ? element : element.querySelector("video");

    // A video is frequently nested inside the reel permalink on Instagram.
    // Check both the element and its ancestors before falling back to the CDN
    // URL, which can be short-lived or absent until playback starts.
    const permalinkSelector =
      'a[href*="/shorts/"], a[href*="/video/"], a[href*="/photo/"], a[href*="/reel/"], a[href*="/reels/"]';
    const link =
      (element instanceof Element && element.closest(permalinkSelector)) ||
      element.querySelector(permalinkSelector) ||
      (video && video.closest(permalinkSelector));

    if (link && link.href) {
      return link.href.split("?")[0].split("#")[0];
    }

    if (video && video.currentSrc) {
      return video.currentSrc;
    }

    return null;
  }

  function sendScrollIncrement(onFailure) {
    try {
      chrome.runtime.sendMessage({ action: "INCREMENT_SCROLL", site }, () => {
        if (chrome.runtime.lastError) {
          onFailure();
        }
      });
    } catch (error) {
      onFailure();
    }
  }

  function checkPendingCount(element) {
    pendingTimers.delete(element);

    if (!isSiteEnabled(site)) {
      return;
    }

    if ((latestVisibility.get(element) ?? 0) < 0.6) {
      return;
    }

    const identity = getVideoIdentity(element);

    if (identity) {
      if (countedIdentities.has(identity)) {
        return;
      }

      rememberIdentity(identity);
      debugLog("[Brain Rot Tracker] counted video:", identity);
      sendScrollIncrement(() => countedIdentities.delete(identity));
      return;
    }

    if (element.getAttribute("data-extension-tracked") === "true") {
      return;
    }

    element.setAttribute("data-extension-tracked", "true");
    debugLog("[Brain Rot Tracker] counted video element (no identity resolvable)");
    sendScrollIncrement(() => element.removeAttribute("data-extension-tracked"));
  }

  const videoObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const element = entry.target;
        const ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
        latestVisibility.set(element, ratio);

        if (ratio >= 0.6) {
          if (!pendingTimers.has(element)) {
            pendingTimers.set(element, setTimeout(() => checkPendingCount(element), MIN_VISIBLE_MS));
          }
        } else {
          const timer = pendingTimers.get(element);
          if (timer) {
            clearTimeout(timer);
            pendingTimers.delete(element);
          }
        }
      }
    },
    { threshold: [0, 0.6] }
  );

  function observeVideosIn(root) {
    for (const selector of domainSelectors) {
      const candidates = root.querySelectorAll(selector);

      for (const element of candidates) {
        if (observedElements.has(element)) {
          continue;
        }

        observedElements.add(element);
        videoObserver.observe(element);
      }
    }
  }

  const mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) {
          continue;
        }

        for (const selector of domainSelectors) {
          if (node.matches(selector) && !observedElements.has(node)) {
            observedElements.add(node);
            videoObserver.observe(node);
          }
        }

        observeVideosIn(node);
      }
    }
  });

  observeVideosIn(document);

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  if (/(^|\.)youtube\.com$/.test(hostname)) {
    const shortWatch = { identity: null, since: 0 };

    setInterval(() => {
      if (!isSiteEnabled(site)) {
        shortWatch.identity = null;
        return;
      }

      if (!window.location.pathname.startsWith("/shorts/")) {
        shortWatch.identity = null;
        return;
      }

      const active = document.querySelector("ytd-reel-video-renderer[is-active]");
      if (!active) {
        return;
      }

      const identity = getVideoIdentity(active);
      if (!identity || countedIdentities.has(identity)) {
        return;
      }

      const now = Date.now();

      if (shortWatch.identity !== identity) {
        shortWatch.identity = identity;
        shortWatch.since = now;
        return;
      }

      if (now - shortWatch.since >= MIN_VISIBLE_MS) {
        rememberIdentity(identity);
        debugLog("[Brain Rot Tracker] counted short via is-active poll:", identity);
        sendScrollIncrement(() => countedIdentities.delete(identity));
      }
    }, 500);
  }

  setInterval(tick, 1000);
})();
