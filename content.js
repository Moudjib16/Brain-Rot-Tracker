(function () {
  "use strict";

  const SYNC_INTERVAL_SECONDS = 1;

  let unsyncedSeconds = 0;
  let windowFocused = true;

  function isUserActive() {
    return document.hidden === false && windowFocused === true;
  }

  function tick() {
    if (isUserActive()) {
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

    const secondsToSend = unsyncedSeconds;
    unsyncedSeconds = 0;

    try {
      chrome.runtime.sendMessage(
        { action: "ADD_ACTIVE_TIME", seconds: secondsToSend },
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

  window.addEventListener("focus", () => {
    windowFocused = true;
  });

  window.addEventListener("blur", () => {
    windowFocused = false;
    flushActiveTime();
  });

  window.addEventListener("pagehide", flushActiveTime);
  window.addEventListener("beforeunload", flushActiveTime);

  const SELECTORS_BY_DOMAIN = [
    { match: /(^|\.)youtube\.com$/, selectors: ["ytd-reel-video-renderer"] },
    { match: /(^|\.)tiktok\.com$/, selectors: ['[data-e2e="recommend-list-item-container"]', "video"] },
    { match: /(^|\.)instagram\.com$/, selectors: ["article", 'div[role="dialog"] video'] }
  ];

  const hostname = window.location.hostname;
  const domainSelectors =
    (SELECTORS_BY_DOMAIN.find((entry) => entry.match.test(hostname)) || {}).selectors ||
    SELECTORS_BY_DOMAIN.flatMap((entry) => entry.selectors);

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

    if (video && video.currentSrc) {
      return video.currentSrc;
    }

    const link = element.querySelector(
      'a[href*="/shorts/"], a[href*="/video/"], a[href*="/photo/"], a[href*="/reel/"], a[href*="/reels/"]'
    );

    if (link && link.href) {
      return link.href.split("?")[0].split("#")[0];
    }

    return null;
  }

  function sendScrollIncrement(onFailure) {
    try {
      chrome.runtime.sendMessage({ action: "INCREMENT_SCROLL" }, () => {
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

    if ((latestVisibility.get(element) ?? 0) < 0.6) {
      return;
    }

    const identity = getVideoIdentity(element);

    if (identity) {
      if (countedIdentities.has(identity)) {
        return;
      }

      rememberIdentity(identity);
      console.debug("[Brain Rot Tracker] counted video:", identity);
      sendScrollIncrement(() => countedIdentities.delete(identity));
      return;
    }

    if (element.getAttribute("data-extension-tracked") === "true") {
      return;
    }

    element.setAttribute("data-extension-tracked", "true");
    console.debug("[Brain Rot Tracker] counted video element (no identity resolvable)");
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
        console.debug("[Brain Rot Tracker] counted short via is-active poll:", identity);
        sendScrollIncrement(() => countedIdentities.delete(identity));
      }
    }, 500);
  }

  setInterval(tick, 1000);
})();
