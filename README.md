# Brain Rot Tracker

A cross-browser (Chrome & Firefox) Manifest V3 extension that tracks how much time you spend on short-form video feeds and how many videos you scroll through each day — YouTube Shorts, TikTok, and Instagram Reels.

## Features

- **Daily active-time tracking** — counts seconds while a supported tab is visible, including while the extension popup is open; syncs to storage every second.
- **Unique videos-scrolled counter** — counts each video once per day, identified by a stable per-video identity (Shorts URL, CDN source URL, or post permalink), not by the fragile recycled DOM elements.
- **Rapid-scroll protection** — a video only counts after staying ≥60% visible for 700 ms, so flicking past videos doesn't inflate the count.
- **Daily auto-reset** — counters reset at local midnight (checked on install, browser startup, and on every message).
- **Live popup UI** — videos scrolled today, active time as `HH:MM:SS`, manual reset button, live updates via `chrome.storage.onChanged`.
- **Cross-browser** — single codebase using `chrome.*` APIs (supported by Firefox) with dual `background.service_worker` / `background.scripts` manifest entries.

## Installation

### Chrome
1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.

### Firefox
1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and select `manifest.json`.
3. For a permanent install, package/sign the extension through addons.mozilla.org (the `browser_specific_settings.gecko` ID is required for MV3 signing).

After editing any file, reload the extension on the extensions page **and refresh open tabs** — content scripts are not injected retroactively.

## How it works

```text
├── manifest.json      # MV3 manifest (Chrome + Firefox entries)
├── background.js      # Service worker / event page: storage schema, daily reset, message handling
├── content.js         # Injected into YouTube/TikTok/Instagram: active-time timer + video counting
└── popup/
    ├── popup.html     # Stats UI
    ├── popup.css      # Styles (300px dark card layout)
    └── popup.js       # Loads/renders stats, reset button, live onChanged updates
```

### Active time
`content.js` runs a 1-second interval. Time accrues only while the page visibility state is `visible`. This deliberately continues while the extension popup is open: opening a browser-extension popup blurs the page, but does not mean you stopped viewing the feed. Accumulated seconds flush to the background every second via `ADD_ACTIVE_TIME` and when the page is hidden or unloaded.

### Video scroll counting
- **YouTube Shorts** — the page keeps a pool of recycled `ytd-reel-video-renderer` elements, so the extension polls every 500 ms for the renderer marked `is-active` and counts a short after the same short ID stays active for 700 ms. This is independent of scroll gesture type (wheel, touchpad, keyboard).
- **TikTok / Instagram Reels** — an `IntersectionObserver` (`threshold: [0, 0.6]`) plus a `MutationObserver` for infinite-scroll DOM additions. Instagram observes the actual video elements so it works across feed, full-screen, and modal Reel layouts. A video counts after sustained 60% visibility for 700 ms.
- Identities are deduplicated in a bounded (300-entry) session set, so revisiting a video doesn't recount it while re-shown content still counts once.

### Background worker
Owns the `chrome.storage.local` schema (`scrolledCount`, `activeTimeSeconds`, `lastResetDate`), performs the daily reset, and handles `INCREMENT_SCROLL` / `ADD_ACTIVE_TIME` (plus `GET_STATS` / `RESET_STATS` helpers).

## Usage tips / debugging

- Open DevTools → Console on a feed page to see `[Brain Rot Tracker] counted ...` debug lines.
- Popup date label shows the current day; counters reset at local midnight.

## Known limitations

- Site DOM changes (selectors in `content.js`) are the most fragile part — TikTok/Instagram especially. If counting stops, compare `ytd-reel-video-renderer`, `[data-e2e="recommend-list-item-container"]`, and Instagram `video` elements against the live DOM.
- The `browser_specific_settings.gecko.id` (`brain-rot-tracker@example.org`) is a placeholder — replace it before signing for AMO.
- Switching days while the browser is open resets stats only when the next message arrives or the popup is opened.
