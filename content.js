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

  setInterval(tick, 1000);
})();
