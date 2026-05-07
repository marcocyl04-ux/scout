# Scout — Blackboard Command Center

A Chrome extension for BU students. Open it, see what's due, get it done.

![Version](https://img.shields.io/badge/version-3.4.1-blue)
![Chrome](https://img.shields.io/badge/Chrome-Manifest%20V3-green)

## What It Does

Scout extracts your courses, deadlines, grades, files, and announcements from Blackboard Ultra and organizes them in one popup:

- **Upcoming** — deadlines grouped by course, sorted by type (Exams → In-Class → Homework)
- **Completed** — submitted/overdue items with grade status
- **File Bundles** — relevant files attached to each deadline automatically
- **Ask AI** — generates a prompt with assignment context, copies to clipboard

It only shows your **current semester** courses (auto-detected).

## Install (2 minutes)

### Step 1: Download

Click the green **Code** button above → **Download ZIP**

Unzip it anywhere (Desktop is fine).

### Step 2: Load in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Turn on **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked** (top-left)
4. Select the unzipped `scout-extension` folder
5. The Scout icon appears in your toolbar ✓

### Step 3: Use

1. Log into [Blackboard](https://learn.bu.edu) in Chrome
2. Click the **Scout** icon in your toolbar
3. Click **Connect to Blackboard**
4. The first time, Chrome will show a bar asking permission for the debugger — **this is normal**. The page will refresh and extraction continues automatically.
5. Done. Your dashboard appears.

## How It Works

Scout uses Chrome's built-in debugger (CDP) to read the Blackboard API responses as you navigate. This is the same approach as the BU developer tools — it's just reading data that Blackboard already sends to your browser.

- **No data leaves your machine** — everything is stored locally in Chrome's storage
- **No Blackboard credentials are accessed** — it reads responses, not your password
- **No server required** — works entirely in the browser

## Refreshing Data

Your data stays cached for **2 hours**. To refresh:

1. Open the Scout popup
2. Click the **↻** button (top-right)
3. Wait for extraction to complete (~1 minute)

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "No memberships API captured" | Make sure you're logged into Blackboard in Chrome. Open learn.bu.edu first, then try again. |
| Popup shows nothing after Extract | Close the popup, wait 10 seconds, reopen. The debugger permission prompt may have refreshed the page. |
| Courses from wrong semester showing | Click ↻ to re-extract. The term filter uses date-based detection. |
| Files not showing for an assignment | Some professors don't attach files to Blackboard. The extension can only show what's there. |
| "Another debugger is already attached" | Close Chrome DevTools if open, then try again. |

## Permissions Explained

| Permission | Why |
|------------|-----|
| `debugger` | Read Blackboard API responses (the core feature) |
| `storage` | Cache your data locally so you don't re-extract every time |
| `tabs` | Find your Blackboard tab to attach the debugger |
| `activeTab` | Access the current tab |
| `host_permissions: learn.bu.edu` | Access Blackboard's API |

## Privacy

- All data stays on your machine
- No analytics, no tracking, no external servers
- Data is cleared when you clear Chrome's extension storage

## For Developers

```bash
# Clone
git clone https://github.com/marcocyl04-ux/scout.git
cd scout

# Load in Chrome
# chrome://extensions/ → Developer mode → Load unpacked → select this folder

# Files
background.js — Service worker (extraction engine)
popup.js      — Rendering + message passing
popup.html    — UI structure
popup.css     — Styles
manifest.json — Extension config
```

## Version History

| Version | Changes |
|---------|---------|
| 3.4.1 | Pruned dead code (content.js, interceptor.js). Fixed file bundling (path-based matching), overdue aging (14-day cutoff), stuck loading state (stale flag cleanup), dismissed deadline persistence, deterministic course colors. |
| 3.4.0 | One-click connect, warm design, greeting, task grouping by type. |
| 3.1.2 | Auto-retry after debugger permission prompt. Cache extended to 1 hour. |
| 3.1.1 | Date-based term filter (primary). Count-based as fallback. |
| 3.1.0 | Recursive nested file traversal. 4-page extraction per course. |
| 3.0.0 | Initial working version with CDP approach. |

## License

MIT — do whatever you want with it.
