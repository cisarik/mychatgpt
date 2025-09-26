# Search Cleaner (MV3 extension)

Search Cleaner keeps short, search-like ChatGPT conversations in a local backup so you can reopen and delete them in the official UI without touching private APIs.

## What it does
- Watches active `chatgpt.com` conversations and stores the first user/assistant turns when they meet the heuristics (message count, age, prompt/answer length).
- Saves each match into IndexedDB (`search-cleaner-db`) so nothing ever leaves your device.
- Lets you reopen the next batch of conversations for manual deletion and export any backup as standalone HTML.
- Provides an optional debug log buffer you can toggle on when you need visibility.

## Why there is no auto-deletion
- OpenAI does not expose a supported API for deleting chats, and UI automation is brittle and risky.
- The core extension therefore limits itself to local capture plus manual follow-up tabs—no hidden tokens, no `/backend-api/*` calls, no DOM clicking.

## Using the cleaner
1. Load the unpacked extension via `chrome://extensions` and pin it if you like.
2. Perform a short, search-like query on chatgpt.com; the conversation should show up in the list within a few seconds once it meets the heuristics (use **Scan** in the popup to nudge a rescan).
3. In the popup, review the captured rows, tick the ones you want to clean up, and press **Open next (N)**.
4. Switch to the newly opened ChatGPT tabs, press **Delete** in the official UI, and confirm.
5. Return to the popup to export or “Forget” completed backups if you want to clear the local snapshot.

## Risky mode (future)
- A separate `ui-automation` adapter will eventually plug into the deletion strategy hook, but it remains disabled and ships with a “coming soon” tooltip.
- The core stays clean and dependency-free so that adding automation later does not contaminate the safe baseline.

