# MyChatGPT (MVP Scaffold)

This repository contains a minimal Manifest V3 Chrome/Brave extension scaffold for the MyChatGPT project.

## Load the extension
1. Open `chrome://extensions` (or Brave equivalent).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this repository folder.

## Verify logging
1. Open the extension popup from the toolbar.
2. Navigate to the **Debug** tab and click **Test log**.
3. Open the dedicated debug page and use **Refresh** to confirm the new entry.

Logs are stored in `chrome.storage.local` under the key `debug_logs`. Use the **Export debug** button on the debug page to download the latest records.

## Settings & Categories
| Key | Default | Description |
| --- | --- | --- |
| `LIST_ONLY` | `true` | Limits the extension to listing actions without edits. |
| `DRY_RUN` | `true` | Produces simulated results without writes. |
| `CONFIRM_BEFORE_DELETE` | `true` | Prompts before any destructive action. |
| `AUTO_SCAN` | `false` | Enables background scanning when supported. |
| `MAX_MESSAGES` | `2` | Maximum total messages captured per conversation. |
| `USER_MESSAGES_MAX` | `2` | Maximum user-authored messages retained. |
| `SAFE_URL_PATTERNS` | `['/workspaces','/projects','/new-project']` | Allowed path patterns for scanning. |

Settings persist under `chrome.storage.local` key `settings_v1`. The settings page automatically validates loaded values and heals any missing/invalid fields back to defaults, marking corrected inputs with a subtle “(opravené)” hint. Use the **Resetovať na defaulty** button to repopulate the form with the defaults before saving.

The IndexedDB store `categories` seeds the following categories on first run: `Programovanie`, `Kryptomeny`, `HW`, `Zdravie`. The background worker repeats the seed check on startup and during installation, logging the outcome.

## Debug scan stub
1. Open the **Debug** page and click **Scan now (stub)**.
2. Observe the inline toast with the deterministic JSON payload (e.g., `{ scanned: 0, matched: 0, dryRun: true }`).
3. Refresh the logs list to review the corresponding entries under the `scan` scope.

## Connectivity test
1. Navigate to [https://chatgpt.com](https://chatgpt.com) in the active browser tab.
2. Open the extension’s **Debug** page and click **Connectivity test (chatgpt.com)**.
3. Review the inline history for the most recent responses and cross-check the `scan` scope logs for the summarized ping result.

## Metadata probe
1. Open a conversation on [https://chatgpt.com](https://chatgpt.com) and launch the **Debug** page.
2. Click **Probe metadata (read-only)** to request a deterministic snapshot of the current tab.
3. If the active URL matches any entry under `SAFE_URL_PATTERNS`, the probe is skipped with a clear notice so you can adjust the page or pattern list.
4. Successful probes return the resolved URL, title, conversation ID (if present), heuristic message counts, and UI markers that feed future `MAX_MESSAGES` controls.
