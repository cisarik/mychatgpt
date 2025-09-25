# MyChatGPT – MV3 Extension

MyChatGPT keeps your ChatGPT account tidy while storing short “search-like” chats locally. The extension watches for short conversations created by the official ChatGPT browser companion, backs them up to IndexedDB, and—when you explicitly allow it—can soft-hide them using the same API the web client uses.

## Key ideas
- Local-first safety: backups live in IndexedDB (`mychatgpt-db`); nothing ever leaves your machine.
- Safe defaults: `LIST_ONLY` and `DRY_RUN` ship as `true`, so no PATCH requests fire unless you disable both *and* confirm.
- Transparent logging: the Debug tab streams the last 500 log entries from `chrome.storage.local`.
- Modular UI: popup offers Searches, Backup, Settings, and Debug tabs with dark-mode aware styling.

## Loading the extension
1. Clone or download this repository.
2. In Chrome/Brave, open `chrome://extensions/`.
3. Toggle on **Developer mode**.
4. Click **Load unpacked** and select the project directory.
5. Pin the “MyChatGPT” extension if you want quick access to the popup.

## How to test KROK 2
1. Load the unpacked extension, then open a short ChatGPT conversation (≤2 visible messages, ≥2 minutes old).
2. Keep the popup open on **Searches**. When you focus the chat tab, the Debug tab should log `Scan started` and either `Backup stored` or the disqualification reason.
3. Click **Backup current chat (manual)** to force a capture; with default settings the toast shows the LIST_ONLY guard unless you flip `ALLOW_LOCAL_BACKUP_WHEN_LIST_ONLY` or disable `LIST_ONLY` entirely.
4. Visit the **Backup** tab to see the newest entry, change its category, preview the sanitized answer, and export the HTML snapshot.
5. Toggle `LIST_ONLY` off in **Settings** and repeat the manual backup to confirm that records persist when the guard rails allow it.

## Diagnostics
- Enable verbose tracing in **Settings > Diagnostics** by setting `DEBUG_LEVEL` to `TRACE` and toggling `TRACE_EXTRACTOR` or `TRACE_RUNNER` as needed; keep `REDACT_TEXT_IN_DIAGNOSTICS` enabled when you want message bodies redacted.
- Use the Debug tab's **Run extractor self-test (active tab)** button to execute the new probe. The result shows selectors tried, warnings, and errors, and the **Copy JSON** shortcut lets you share the snapshot locally.
- Flip on `DIAGNOSTICS_SAFE_SNAPSHOT` to persist the last probe into `debug_last_extractor_dump`; the Debug tab renders the most recent snapshot for quick review.
- Open the service worker console via `chrome://extensions -> MyChatGPT -> "Service worker" -> Inspect` to watch streaming logs. Reason codes such as `cooldown_active`, `tab_ignored_safe_url`, `qualify_false_messages_gt_max`, `qualify_true`, `probe_failed`, and `backup_stored` map directly to runner decision points.

## Auto-scan & Would-delete (simulated)
- The service worker auto-scans chatgpt.com tabs when the extension installs, Chrome starts, or a chat tab activates/completes loading. Per-tab and global cooldown timers (respecting `COOLDOWN_MIN`) prevent excessive polling, and SAFE URL patterns continue to short-circuit eligible pages.
- Conversations qualify for the simulated “would-delete” list only when they meet the heuristics: `messageCount ≤ MAX_MESSAGES`, `userMessageCount ≤ USER_MESSAGES_MAX`, `lastMessageAgeMin ≥ MIN_AGE_MINUTES`, and within the optional `DELETE_LIMIT`. Missing metadata or safe-domain matches keep them off the list.
- LIST_ONLY and DRY_RUN stay enabled by default, so the feature never issues real DELETE/PATCH requests. The Debug report is strictly a preview of what *would* be deleted.
- Open **Debug → Would-delete report (simulated)** to refresh counters, export `mychatgpt_would_delete.csv`, clear the log, or trigger **Scan all open chat tabs now** for a manual sweep. The popup badge mirrors the current qualified count so you can jump straight to Debug.

## Soft-delete DRY-RUN (no network)
- Open **Debug → Soft-delete DRY-RUN plan** to build a PATCH preview from the latest would-delete snapshot. Each entry shows the synthetic request (`PATCH /conversation/{id}` with `{is_visible:false}`) plus a diff preview (`is_visible: true → false`).
- The justification viewer explains why each conversation qualifies, including the age/message heuristics and any disqualifying flags; the same reason codes appear in the Debug logs.
- Use **Regenerate plan from current report** after an auto-scan to refresh the plan (respecting `REPORT_LIMIT` and deduplicated by conversation). **Simulate batch confirm (log-only)** only appends to `soft_delete_confirmed_history` and logs `dry_run_confirmed`; nothing hits the network.
- Export the JSON plan for external review, clear the plan if you want to start over, and rely on the popup badge to track how many DRY-RUN deletions are staged.

## Troubleshooting `no_injection`
If you see `reasonCode=no_injection` in the logs, open the **Debug** tab, click **Force inject content script**, or reload the chat tab. Remember to reload the extension after any manifest changes.

## Troubleshooting `cooldown_active`
`cooldown_active` means the per-tab or global cooldown is still in effect. Wait for the configured `COOLDOWN_MIN` interval or launch **Scan all open chat tabs now** from Debug with the cooldown bypass.

## Current limitations
- DOM scraping relies on data attributes from chatgpt.com; major UI changes can break extraction until heuristics are updated.
- Runner never issues PATCH/DELETE calls—`DRY_RUN` remains in place and only local backups/logs are produced.
- No automated tests yet; verify flows manually through the popup and Debug tab.

## Development notes
- Manifest V3, background service worker written as an ES module.
- IndexedDB stores `backups` and `categories`; the latter is seeded with `Programovanie`, `Kryptomeny`, `HW`, and `Zdravie` on first run.
- Comments and docstrings live in Slovak per the Analytic Programming protocol.
- No external dependencies or build steps; everything is plain JS + HTML + CSS.
