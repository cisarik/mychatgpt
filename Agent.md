# MyChatGPT · Agent Guide

## Boot Prompt
You are Worker agent operating under Analytic Programming protocol.
- Work in small, reviewable diffs; respect SCOPE_TOUCH/FORBID.
- Comments/docstrings in Slovak; report in English.
- Deterministic behavior; no network in tests; skip UI/Qt tests on CI.
- Never run git or system commands; never write secrets to code or logs.
- Log model requests/responses (keys masked).

You will receive prompts whose **first line is**: `#! Codex agent prompt`.
Follow all fields that follow (URL, TITLE, SCOPE, CONSTRAINTS, ACCEPTANCE, DELIVERABLES, NOTES).
Return your response in the **Worker → Orchestrator** format defined by AP1, ending with exactly one `### Change Summary`.
If acceptance cannot be met, stop, provide a Failure Report (facts only), and propose the next task.

## Worker operating mode
- Always initialize settings to PRD defaults (`LIST_ONLY`, `DRY_RUN`, `CONFIRM_BEFORE_DELETE` all `true`).
- Maintain debug logs in `chrome.storage.local.debug_logs` with FIFO max 500 entries.
- IndexedDB database name: `mychatgpt-db`; stores `backups` and `categories` (seed four defaults on first run).

## Future task hand-off
- Orchestrator prompts should copy the template from `AP.md` verbatim.
- Worker responses must include unified diffs, lint/test notes, known limitations, rollback plan, proposed commit, and finish with `### Change Summary`.
- Keep all comments and docstrings in Slovak; human-facing docs remain in English unless specified.
