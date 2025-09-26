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
