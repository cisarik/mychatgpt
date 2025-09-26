# MyChatGPT cleaner

Ultra-minimal MV3 helper that captures the first turn of every open chatgpt.com conversation and, when you dare, clicks the header Delete for you. No sidebars, no hidden APIs, no reloads.

## How it works
1. Open a handful of `https://chatgpt.com/c/<id>` tabs with short “search-like” prompts.
2. Pop the extension and hit **Refresh** – it captures the first user/assistant pair from every open tab and saves it locally.
3. Flip **Risky mode** on if you want it to press Share → kebab → Delete → Confirm in the header and mark the chat as deleted once verification passes.

## Why minimal
The extension only reads the DOM that is already on screen and clicks official header controls. There are no sidebar injections, no background API calls, and no repeated reload loops – just a single Refresh that handles capture, optional backup flagging, and header-only deletion.

## Troubleshooting
- Nothing happened? Check the console of the specific ChatGPT tab for `[RiskyMode][tab]` logs – failures come with `FAIL code=…` hints.
- Capture failed? Reload the conversation tab and try Refresh again; ensure the page is on `/c/<id>` and fully loaded.
- Header automation flaky? Bump the millisecond fields in **Settings** (step timeout / waits / between tabs) before retrying with Risky mode enabled.
