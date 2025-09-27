# MyChatGPT (MVP Scaffold)

This repository contains a minimal Manifest V3 Chrome/Brave extension scaffold for the MyChatGPT project.

## Load the extension
1. Open `chrome://extensions` (or Brave equivalent).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this repository folder.

## Where to see logs
1. Open the extension popup from the toolbar and switch to the **Debug** tab.
2. Click **Test log** to emit a sample entry. The background Service worker console (open it via `chrome://extensions` → MyChatGPT → **Service worker → Inspect views**) will show `[MyChatGPT] Test log (SW) …` alongside the persisted log entry.
3. With an active `https://chatgpt.com` tab, open its DevTools (`Ctrl/Cmd + Shift + I`) to see `[MyChatGPT] Test log (page)` routed from the content script. If no chatgpt.com tab is active, only the Service worker console prints.

Logs are stored in `chrome.storage.local` under the key `debug_logs`. Use DevTools consoles to stream live entries instead of the in-page log list.

## Popup navigation
- The popup now keeps Searches, Settings, and Debug content on a single surface with in-place tab switching.
- All "Open detailed view" links were removed—each tab renders its full controls, including settings inputs and debug tools, directly inside the popup.
- Hash deep-links (`#searches`, `#settings`, `#debug`) activate the matching panel so you can bookmark or share precise popup states.
- Invalid or missing hashes automatically fall back to the Searches panel while updating the popup hash to stay in sync.

## Theme & Accessibility
- Default experience ships with a modern dark theme tuned for ChatGPT-like contrast, while a light fallback automatically applies for users preferring light mode via `prefers-color-scheme`.
- Shared CSS tokens drive page, popup and log surfaces to maintain ≥AA contrast for text, buttons and links across both palettes.
- Interactive controls expose visible focus rings, hover states and disabled styling for assistive clarity.

## Popup sizing & troubleshooting
- The popup enforces a minimum footprint of 360×480 while remaining responsive up to a 720×720 ceiling.
- If the popup opens unusually narrow, reload the extension, ensure no custom CSS overrides are injected, and verify operating system scaling settings.
- Use the popup’s DevTools to inspect the computed sizes on `html`, `body`, and `.popup-root` if issues persist.

## Settings & Categories
| Key | Default | Description |
| --- | --- | --- |
| `LIST_ONLY` | `true` | Limits the extension to listing actions without edits. |
| `DRY_RUN` | `true` | Produces simulated results without writes. |
| `CAPTURE_ONLY_CANDIDATES` | `true` | Restricts manual backups to short candidate chats. |
| `CONFIRM_BEFORE_DELETE` | `true` | Prompts before any destructive action. |
| `AUTO_SCAN` | `false` | Enables background scanning when supported. |
| `MAX_MESSAGES` | `2` | Maximum total messages captured per conversation. |
| `USER_MESSAGES_MAX` | `2` | Maximum user-authored messages retained. |
| `SCAN_COOLDOWN_MIN` | `5` | Minimum minutes between automated heuristics scans. |
| `SAFE_URL_PATTERNS` | `['/workspaces','/projects','/new-project','https://chatgpt.com/c/*']` | Allowed path/full URL patterns for scanning. |

Settings persist under `chrome.storage.local` key `settings_v1`. The settings page automatically validates loaded values and heals any missing/invalid fields back to defaults, marking corrected inputs with a subtle “(opravené)” hint. Use the **Resetovať na defaulty** button to repopulate the form with the defaults before saving.

### Safe URL patterns
- Each non-empty line accepts either:
  - A leading-slash substring (e.g., `/workspaces`) matched against the ChatGPT tab’s `URL.pathname`.
  - A full URL with an optional trailing `*` wildcard (suffix glob), e.g., `https://chatgpt.com/c/*`.
- Lines starting with `#` are treated as comments and skipped. Duplicates are removed automatically.
- The defaults ship with `/workspaces`, `/projects`, `/new-project`, and `https://chatgpt.com/c/*`.

### SAFE URL patterns (storage)
- `settings_v1.SAFE_URL_PATTERNS` in `chrome.storage.local` je jediným zdrojom pravdy.
- Textarea na stránke **Settings** priamo číta aj ukladá tieto hodnoty po normalizácii.
- Service worker pred každou stráženou akciou načíta čerstvé nastavenia zo storage, takže sa neopiera o cache ani lokálne fallbacky.

The IndexedDB store `categories` seeds the following categories on first run: `Programovanie`, `Kryptomeny`, `HW`, `Zdravie`. The background worker repeats the seed check on startup and during installation, logging the outcome.

## Auto-scan feed stub
1. Open the **Debug** page and click **Auto-scan feed (stub)**.
2. Observe the inline toast with the deterministic JSON payload (e.g., `{ scanned: 0, matched: 0, dryRun: true }`).
3. Inspect the background Service worker console to see the corresponding `scan` scope log entry.

## Connectivity test
1. Navigate to [https://chatgpt.com](https://chatgpt.com) in the active browser tab.
2. Open the extension’s **Debug** page and click **Connectivity test (chatgpt.com)**.
3. Review the inline history for the most recent responses and cross-check the `scan` scope logs for the summarized ping result.

## Metadata probe
1. Open a conversation on [https://chatgpt.com](https://chatgpt.com) and launch the **Debug** page.
2. Click **Probe metadata (read-only)** to request a deterministic snapshot of the current tab.
3. If the active URL matches any entry under `SAFE_URL_PATTERNS`, the probe is skipped with reason code `probe_safe_url` so you can adjust the page or pattern list.
4. Successful probes return the resolved URL, title, conversation ID (if present), heuristic message counts, and UI markers that feed future `MAX_MESSAGES` controls.

## Capture preview (read-only)
1. With a ChatGPT conversation active, click **Capture preview (read-only)** on the **Debug** page to trigger a content-script capture without persisting a backup.
2. SAFE URL matches respond with reason code `capture_safe_url` and skip the capture; remove or adjust the pattern to allow previews.
3. Successful captures include the question/answer lengths in the debug panel and log a `capture_ok` summary in the Service worker console.

## Heuristics V1 & Cooldown
- The background worker exposes **Evaluate heuristics (active tab)** on the debug page to score the active ChatGPT conversation without mutating the DOM or touching IndexedDB.
- SAFE URL patterns always bypass the heuristic, while candidates require `counts.total ≤ MAX_MESSAGES` and, when available, `counts.user ≤ USER_MESSAGES_MAX`. Unknown totals defer the decision.
- Reason codes reported to logs/debug history include: `candidate_ok`, `over_max` (including user limit breaches), `heuristics_safe_url`, `counts_unknown`, and `no_probe` when the metadata probe is unavailable.
- Every evaluation updates `cooldown_v1.lastScanAt`. Auto-scans will respect `SCAN_COOLDOWN_MIN` minutes before re-running, while the manual debug button surfaces whether the cooldown would still delay an automated pass.

## Backup write V1
- The debug page now includes **Backup now (manual)**, which captures the active ChatGPT tab via the existing read-only content script and queues a single write into the `backups` IndexedDB store.
- When `CAPTURE_ONLY_CANDIDATES` is enabled (default), manual backups reuse Heuristics V1 to require short conversations; disable the toggle in Settings to allow any chat.
- `DRY_RUN=true` still performs the capture but skips persistence, surfaces a “Dry run: not persisted” toast, and keeps Searches unchanged.
- Captured answers are truncated to 250 KB (UTF-8) when necessary and flagged with `answerTruncated=true` so UI cards and logs can call out the reduction.
- The Searches panel refreshes automatically after writes, rendering question text inline and exposing a sandboxed “Render answer (safe)” iframe to preview HTML without executing scripts.
