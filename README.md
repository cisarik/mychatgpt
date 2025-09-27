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

## Settings keys
| Key | Default | Description |
| --- | --- | --- |
| `LIST_ONLY` | `true` | Limits the extension to listing actions without edits. |
| `DRY_RUN` | `true` | Produces simulated results without writes. |
| `CONFIRM_BEFORE_DELETE` | `true` | Prompts before any destructive action. |
| `AUTO_SCAN` | `false` | Enables background scanning when supported. |
| `SHOW_CANDIDATE_BADGE` | `true` | Displays the candidate badge beside eligible conversations. |
| `CAPTURE_ONLY_CANDIDATES` | `true` | Restricts manual backups to short candidate chats. |
| `MAX_MESSAGES` | `2` | Maximum total messages captured per conversation. |
| `USER_MESSAGES_MAX` | `2` | Maximum user-authored messages retained. |
| `SCAN_COOLDOWN_MIN` | `5` | Minimum minutes between automated heuristics scans. |
| `MIN_AGE_MINUTES` | `2` | Minimum age (in minutes) a conversation must reach before deletion. |
| `DELETE_LIMIT` | `10` | Upper bound for deletes within a single batch. |
| `SAFE_URL_PATTERNS` | `['/workspaces','/projects','/new-project','https://chatgpt.com/c/*']` | Allowed path/full URL patterns for scanning. |

Every input in the Settings UI uses an `id` and `name` attribute that exactly matches its key in `settings_v1`.

Settings persist under `chrome.storage.local` key `settings_v1`. The settings page automatically validates loaded values and heals any missing/invalid fields back to defaults, marking corrected inputs with a subtle “(opravené)” hint. Use the **Resetovať na defaulty** button to repopulate the form with the defaults before saving.

### Ako funguje Settings formulár
- UI používa mapu `kľúč ↔ selektor`, takže `loadSettingsFresh()` načíta aktuálne `settings_v1`, mergne ich s defaultmi a priamo pre-rendruje vstupy cez `renderSettings()`.
- Tlačidlo **Uložiť** zavolá `readFormValues()` → `saveSettings(next)`, ktoré uloží merge, zaloguje diff a hneď znovu vykreslí formulár bez potreby reloadu.
- **Resetovať na defaulty** prepíše `settings_v1` na `SETTINGS_DEFAULTS` a následne zavolá `renderSettings()` na idempotentné vyplnenie čistými hodnotami.
- Textarea pre SAFE URL pracuje len s `settings_v1.SAFE_URL_PATTERNS`, takže storage ostáva jediným zdrojom pravdy aj pri manuálnych úpravách.

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
4. Use the nearby **Check content script** button for a quick status pulse after SPA navigations—the label flips to “Content script aktívny” when the retry ping succeeds.

## Metadata probe
1. Open a conversation on [https://chatgpt.com](https://chatgpt.com) and launch the **Debug** page.
2. Click **Probe metadata (read-only)** to request a deterministic snapshot of the current tab.
3. If the active URL matches any entry under `SAFE_URL_PATTERNS`, the probe is skipped with reason code `probe_safe_url` so you can adjust the page or pattern list.
4. Successful probes return the resolved URL, title, conversation ID (if present), heuristic message counts, and UI markers that feed future `MAX_MESSAGES` controls.

## Capture preview (read-only)
1. With a ChatGPT conversation active, click **Capture preview (read-only)** on the **Debug** page to trigger a content-script capture without persisting a backup.
2. SAFE URL matches respond with reason code `capture_safe_url` and skip the capture; remove or adjust the pattern to allow previews.
3. Successful captures include the question/answer lengths in the debug panel and log a `capture_ok` summary in the Service worker console.

## Bulk backup (open tabs)
- Trigger the **Backup candidates (open tabs)** button from the popup Searches tab or the Debug page toolbar to scan every open `https://chatgpt.com/*` tab sequentially.
- SAFE URL patterns are enforced up front; matching tabs land in the `safe_url` bucket without probing or capturing content.
- Heuristics V1 always applies (short chats only). Tabs missing counts contribute to `counts_unknown`, while over-limit conversations increment `over_max`.
- Each successful candidate requires a `convoId`; duplicates are skipped via `Database.getBackupByConvoId` so existing backups stay untouched.
- When `DRY_RUN=true`, the summary returns a `wouldWrite` list, surfaces a **“Dry run—nothing persisted”** toast, and leaves IndexedDB unchanged so the Searches list stays as-is.
- With `DRY_RUN=false`, truncated answers (≤250 KB) are persisted via `Database.saveBackup`, the Searches panel refreshes immediately, and history cards surface the candidate counts alongside an “Open list” shortcut in the toast when new rows land.
- Check the background Service worker console (`Inspect views`) for `scope:"db"` entries labelled `bulk_backup_ok`, `bulk_backup_dry_run`, or `bulk_backup_error` to audit each run.

## Searches panel
- The list now uses the first captured user message as the primary, clickable title (falling back to **“(untitled)”**) that opens `pages/backup_view.html?id=<uuid>` in a new tab.
- The metadata line prints the localized timestamp and adds a `(truncated)` badge when applicable, keeping conversation IDs out of the UI.
- The “Počet záloh v úložisku” counter reads straight from IndexedDB, and the page listens for background `backups_updated/searches_reload` broadcasts to refresh without a manual reload.

## Heuristics V1 & Cooldown
- The background worker exposes **Evaluate heuristics (active tab)** on the debug page to score the active ChatGPT conversation without mutating the DOM or touching IndexedDB.
- SAFE URL patterns always bypass the heuristic, while candidates require `counts.total ≤ MAX_MESSAGES` and, when available, `counts.user ≤ USER_MESSAGES_MAX`. Unknown totals defer the decision.
- Reason codes reported to logs/debug history include: `candidate_ok`, `over_max` (including user limit breaches), `heuristics_safe_url`, `counts_unknown`, and `no_probe` when the metadata probe is unavailable.
- Auto-scans update `cooldown_v1.lastScanAt` and respect `SCAN_COOLDOWN_MIN` before re-running. Manual evaluations always return `cooldown.used=false`, signalling that cooldown gating is ignored in the debug workflow.

## Troubleshooting
- Chrome MV3 does not support the `chrome.tabs.sendMessage` timeout option; we implement a manual timeout plus a one-time auto-injection & retry when the receiver is missing.
- When a ChatGPT tab briefly lacks the content script (e.g., after a Next.js route swap), the background worker automatically re-injects `content.js` and retries once. The service worker console logs a single `{ scope: 'content', reasonCode: 'cs_injected_retry' }` line the first time recovery runs.
- Open DevTools on chatgpt.com and look for `[MyChatGPT] content.js loaded` (plus occasional “content.js active” notices) to confirm the script is live without sending messages.
- Manual **Evaluate heuristics** calls skip cooldown checks entirely; only auto-scan jobs wait on `cooldown_v1`. The debug panel now renders `cooldown=inactive` for those manual runs.

## Backup write V1
- The debug page now includes **Backup now (manual)**, which captures the active ChatGPT tab via the existing read-only content script and queues a single write into the `backups` IndexedDB store.
- When `CAPTURE_ONLY_CANDIDATES` is enabled (default), manual backups reuse Heuristics V1 to require short conversations; disable the toggle in Settings to allow any chat.
- `DRY_RUN=true` still performs the capture but skips persistence, surfaces a “Dry run: not persisted” toast, and keeps Searches unchanged.
- Captured answers are truncated to 250 KB (UTF-8) when necessary and flagged with `answerTruncated=true` so UI cards and logs can call out the reduction.
- The Searches panel refreshes automatically after writes, rendering question text inline and linking directly to the Backup View page for full, inline HTML display.

## Backup View page
- Click any question in **Searches** to open `pages/backup_view.html?id=<uuid>` in a regular browser tab. The page mirrors the dark popup styling and focuses the stored prompt as a tab-like primary button.
- The header button now launches `https://chatgpt.com/?q=<query>&hints=search` in a new tab (or via middle/⌘-click) with the captured prompt prefilled. The metadata row only shows the localized timestamp plus a `(truncated)` badge when applicable—conversation IDs are intentionally omitted.
- Saved answers render directly on the base surface with no extra card background. Stored HTML is inserted inline, and anchor tags are converted to tab-like buttons that open hardened new tabs (`target="_blank"`, `rel="noopener"`).
- Missing or invalid IDs surface inline error messages within the answer area.

## Evaluate & Backup (if candidate)
- The Debug toolbar now offers **Evaluate & Backup (if candidate)**. It runs the existing heuristics on the active ChatGPT tab, ignoring cooldowns, and immediately triggers the manual backup flow when the conversation qualifies.
- SAFE URL patterns still short-circuit the action, and `DRY_RUN` keeps writes simulated while logging the intended result. Dedicated history and toast updates summarize `reasonCodes`, conversation IDs, and whether the backup was persisted.
- The background worker reuses truncation and duplicate checks (via `Database.getBackupByConvoId`) so existing backups remain untouched.
