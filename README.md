# Search Cleaner (MV3 extension)

Search Cleaner keeps short, search-like ChatGPT conversations in a local backup so you can reopen and delete them in the official UI without touching private APIs.

## What it does
- Watches active `chatgpt.com` conversations and stores the first user/assistant turns when they meet the heuristics (message count, age, prompt/answer length).
- Saves each match into IndexedDB (`search-cleaner-db`) so nothing ever leaves your device.
- Lets you reopen the next batch of conversations for manual deletion and export any backup as standalone HTML.
- Keeps everything local-first with an optional console debug toggle (no log panels, no remote calls).

## Why there is no auto-deletion by default
- OpenAI does not expose a supported API for deleting chats, and UI automation can break whenever the UI shifts.
- The core extension therefore ships with safe defaults: local capture plus manual follow-up tabs—no hidden tokens, no `/backend-api/*` calls, no DOM clicking unless you opt into Risky mode.

## Using the cleaner
1. Load the unpacked extension via `chrome://extensions` and pin it if you like.
2. Perform a short, search-like query on chatgpt.com; the conversation should show up in the list within a few seconds once it meets the heuristics (use **Scan** in the popup to nudge a rescan).
3. In the popup, review the captured rows, tick the ones you want to clean up, and press **Open next (N)**.
4. Switch to the newly opened ChatGPT tabs, press **Delete** in the official UI, and confirm.
5. Return to the popup to export or “Forget” completed backups if you want to clear the local snapshot.

## Risky mode (UI automation)
- **Use at your own risk.** The automation only simulates official UI clicks, but it still depends on DOM selectors that can break without warning.
- It is off by default. Toggle *Enable Risky mode (UI automation)* and press **Enable for 10 minutes** to start a session. When the timer expires (or you disable the toggle), deletion falls back to opening tabs manually.
- The flow: **Scan** → select rows → enable Risky mode session → **Delete selected**. Watch DevTools console for `[RiskyMode]` traces (use the settings toggle if you want extra `[Cleaner]` debug lines).
- Dry run support: enable *Dry run (no clicks)* to verify selectors without confirming deletion. The automation locates buttons, logs intent, and exits before the destructive click.
- Troubleshooting:
  - Run **Test selectors** on the active tab; it logs a `[RiskyMode] Probe summary` (header/sidebar/menu/confirm) in the tab console and returns a ✓/× readout in the popup.
  - If the probe times out, increase `risky_step_timeout_ms`, make sure the conversation view is fully loaded, and try the sidebar path by selecting the chat in the left navigation.
  - If the kebab button only shows on hover, the automation reveals it automatically—ensure the element can scroll into view.
  - Still failing? Capture the `[RiskyMode]` console logs (including evidence payloads) and tune selectors or timeouts.
- Everything runs locally—no hidden APIs, only `chrome.scripting.executeScript` driving the public UI.

### Selector diagnostics
1. Open DevTools directly inside the chatgpt.com tab that shows the conversation.
2. Enable *Debug* in the extension popup so `[Cleaner]` logs stay verbose.
3. Click **Test selectors (active tab)** in the popup and check the tab console for `[RiskyMode]` entries.
4. If you see `NOT FOUND` for kebab/delete/confirm, wait a moment—sidebar fallbacks kick in automatically.
5. When the probe still fails, bump `risky_step_timeout_ms`, toggle *Dry run*, re-run the probe, and share the tab console output.

> Tip: All debug output now lives in the console. Open DevTools on the extension popup or the target chat tab to inspect `[Cleaner]` and `[RiskyMode]` logs.
