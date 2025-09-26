# MyChatGPT cleaner

This MV3 extension keeps a lightweight backup of the first turn in each ChatGPT conversation and offers a header-only deletion helper. Everything runs in the browser: no private APIs, no sidebar automation, and no page reloads.

## Features
- **Force capture** – grab the active `/c/<id>` tab even if it fails heuristics.
- **Scan** – sweep every open chatgpt.com tab with a short jitter to stay polite.
- **Show all** – list every stored item, bypassing the eligibility filter.
- **Test selectors** – run the header probe on the active tab; the tab console prints `[RiskyMode][tab] share✓ kebab✓ menu✓ confirm✓` when everything is wired.
- **Risky delete** – header-only clicks from the popup (**Delete current tab (risky)** or **Delete selected**): Share → kebab → Delete → Confirm → verify, no reloads.
- **Safe batch** – each selected row is probed first; only rows with a successful probe enter the destructive path.
- **Status pulses** – the popup keeps text short; detailed traces live in the tab console (`[Cleaner]`, `[RiskyMode]`).

## Why no API delete?
OpenAI does not expose a supported deletion API. The risky path stays in the visible header and clicks official controls only. Toggle **Risky mode** in the popup when you are ready; disable it (or use **Dry run**) to stop real clicks.

## Workflow
1. Open a conversation on chatgpt.com and press **Force capture (active tab)**.
2. Press **Test selectors (active tab)** and check the tab console for `[RiskyMode][tab]` output (share→kebab→menu→confirm).
3. Enable **Risky mode**, keep **Dry run** off, then either press **Delete current tab (risky)** for a quick pass or select multiple rows and press **Delete selected**.
4. Watch the progress counter; each success marks the row as `OK` without reloading the tab.

> 💡 Non-eligible chats prompt a one-time “Delete anyway?” inline confirm in the popup before the risky action proceeds.

## Troubleshooting
- Force capture tips:
  - Keep the active tab on `https://chatgpt.com/c/<id>` before pressing the button.
  - Seeing `capture_api_missing`? Reload the extension (MV3 worker) and try again.
  - Confirm the extension still has host permissions for `https://chatgpt.com/*`.
- Probe fails? Increase `risky_wait_after_open_ms` or `risky_step_timeout_ms` in `chrome.storage.local` (both default to 260 ms / 10 s) and rerun **Test selectors**.
- Unsure what happened? Open the tab console; every automation message carries the `[RiskyMode][tab]` prefix, while background notes use `[Cleaner]`.
