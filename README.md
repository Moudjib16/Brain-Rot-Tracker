# Brain Rot Tracker

Brain Rot Tracker is a Manifest V3 browser extension for Chrome and Firefox that keeps a daily tally of time spent on short-form video feeds and the videos you view.

It supports YouTube Shorts, TikTok, and Instagram Reels.

## What it tracks

- **Active time** — time accrued while a supported feed is visible in the active tab.
- **Videos viewed** — a video is counted once after it has remained at least 60% visible for 700 ms.
- **Daily stats** — each local calendar day is stored separately, so history is kept
  instead of being overwritten by the daily rollover.
- **Per-platform totals** — videos and time are tracked separately for YouTube, TikTok,
  and Instagram.

The popup shows today's video count and active time, a seven-day chart, your current
streak, a per-platform breakdown, CSV/JSON export buttons, and a **Reset today** button
with an eight-second undo. It follows the operating system's light or dark theme. The
toolbar badge shows today's video count.

## How it works

The extension uses a content script on supported sites and stores all statistics locally with `chrome.storage.local`.

| Platform | Detection approach |
| --- | --- |
| YouTube Shorts | Polls the active `ytd-reel-video-renderer` because Shorts recycles page elements. |
| TikTok | Watches recommended-video containers and video elements with an `IntersectionObserver`. |
| Instagram Reels | Watches video elements with an `IntersectionObserver`, covering feed, full-screen, and modal reels. |

Videos are deduplicated by a stable identifier when one is available (such as a Shorts ID, permalink, or video source URL). A bounded in-memory cache prevents repeat counts as an item is revisited during the same session.

## Install locally

### Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Select **Load unpacked**.
4. Choose this repository folder.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `manifest.json` from this repository.

Reload the extension after changing its files, then refresh any already-open supported pages so the updated content script can run.

## Project structure

```text
.
├── manifest.json       # Extension metadata, permissions, and site matches
├── background.js       # History storage, badge, alarms, and message handling
├── content.js          # Active-time and video-view tracking in supported feeds
├── icons/              # 16/32/48/128 px icons
└── popup/
    ├── popup.html      # Extension popup markup
    ├── popup.css       # Popup styling and light/dark themes
    └── popup.js        # Chart, streak, breakdown, export, reset, and undo
```

## Storage

The extension stores all statistics locally under one `stats` key:

```json
{
  "stats": {
    "version": 2,
    "history": {
      "2026-11-03": {
        "scrolledCount": 42,
        "activeTimeSeconds": 1830,
        "sites": {
          "youtube": { "scrolledCount": 30, "activeTimeSeconds": 1200 },
          "tiktok": { "scrolledCount": 12, "activeTimeSeconds": 630 }
        }
      }
    }
  }
}
```

History is pruned after 365 days. Users upgrading from version 1 are migrated
automatically: the old flat `scrolledCount` / `activeTimeSeconds` / `lastResetDate`
values are folded into history under the date they belonged to.

No account, server, or external analytics service is used.

## Export

The popup can export the full history as either format. Files are generated locally and
saved through the browser's normal download mechanism.

- **CSV** — one row per day with total and per-platform counts and active seconds.
- **JSON** — the raw history plus the extension name, schema version, and export time.

## Notes and limitations

- Platform page markup can change, especially on TikTok and Instagram. If counting stops, the site selectors in `content.js` may need updating.
- The Firefox extension ID in `manifest.json` is a placeholder. Replace it before packaging or signing for Firefox Add-ons.
- A new day starts automatically when the date changes; the previous day remains in
  history instead of being cleared. A midnight alarm prunes expired history and
  refreshes the toolbar badge.

## Development

There is no build step. Edit the JavaScript, HTML, or CSS files directly, reload the extension, and refresh the relevant feed page to test the change.
