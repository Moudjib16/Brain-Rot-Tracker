(function () {
  "use strict";

  const SYNC_INTERVAL_SECONDS = 5;

  let activeSeconds = 0;
  let unsyncedSeconds = 0;

  function isUserActive() {
    return document.hidden === false && document.hasFocus() === true;
  }

  function tick() {
    if (isUserActive()) {
      activeSeconds += 1;
      unsyncedSeconds += 1;

      if (activeSeconds % SYNC_INTERVAL_SECONDS === 0) {
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

  window.addEventListener("blur", () => {
    flushActiveTime();
  });

  window.addEventListener("pagehide", flushActiveTime);
  window.addEventListener("beforeunload", flushActiveTime);

  const SELECTORS_BY_DOMAIN = [
    { match: /(^|\.)youtube\.com$/, selectors: ["ytd-reel-video-renderer"] },
    { match: /(^|\.)tiktok\.com$/, selectors: ['div[data-e2e="recommend-list-item-container"]', "video"] },
    { match: /(^|\.)instagram\.com$/, selectors: ["article", 'div[role="dialog"] video'] }
  ];

  const hostname = window.location.hostname;
  const domainSelectors =
    (SELECTORS_BY_DOMAIN.find((entry) => entry.match.test(hostname)) || {}).selectors ||
    SELECTORS_BY_DOMAIN.flatMap((entry) => entry.selectors);

  const observedElements = new WeakSet();
  const MIN_VISIBLE_MS = 700;
  const latestVisibility = new WeakMap();
  const pendingTimers = new WeakMap();

  function sendScrollIncrement(element) {
    try {
      chrome.runtime.sendMessage({ action: "INCREMENT_SCROLL" }, () => {
        if (chrome.runtime.lastError) {
          element.removeAttribute("data-extension-tracked");
        }
      });
    } catch (error) {
      element.removeAttribute("data-extension-tracked");
    }
  }

  function checkPendingCount(element) {
    pendingTimers.delete(element);

    if ((latestVisibility.get(element) ?? 0) < 0.6) {
      return;
    }

    if (element.getAttribute("data-extension-tracked") === "true") {
      return;
    }

    element.setAttribute("data-extension-tracked", "true");
    sendScrollIncrement(element);
  }

  const videoObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const element = entry.target;
        const ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
        latestVisibility.set(element, ratio);

        if (element.getAttribute("data-extension-tracked") === "true") {
          continue;
        }

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

  setInterval(tick, 1000);
})();
