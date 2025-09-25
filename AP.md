# Analytic Programming Protocol

> **Purpose.** Make collaboration between **Owner** (you), **Orchestrator** (me), and **Worker** (Codex Agent) smooth, deterministic, and reviewable. This document standardizes task prompts, responses, scope control, and quality gates while staying lightweight.

---

## 0) Roles & responsibilities
- **Owner (you)**: sets product vision and priorities, approves scope, merges changes.
- **Orchestrator (ChatGPT)**: decomposes objectives into atomic tasks, drafts precise prompts and acceptance criteria, curates scope & constraints, reviews Worker results.
- **Worker (Codex Agent)**: applies focused code diffs; follows scope, tests, and style; reports back in the exact response format.

**Guiding principles**
- Small, reversible diffs; deterministic behavior; strict interfaces; no surprises.
- Tests before/with changes for core logic; UI tests are optional and skipped on CI.
- Minimize dependencies; never touch secrets; zero flakiness.
- Be explicit about **what may be edited** (SCOPE) and **what is forbidden**.

---

## 1) Repository & artifacts (baseline)
- **PRD.md**: product requirements, always the single source of truth.
- **AGENTS.md**: this protocol + the **Boot Prompt** and project‑specific rules.
- **.env** (git‑ignored): secrets; never printed in logs or diffs.
- **Quality gates**: `ruff`, `mypy --strict`, `pytest`. UI/Qt tests optional and skipped on CI.
- **Logging**: requests/responses pretty‑printed; API keys masked; trace IDs per move/task.

---

## 2) Orchestrator → Worker prompt (MUST start with a header)
The **first line MUST be exactly**:
```
#! Codex agent prompt
```

Then use the fields below (plain text; order fixed). Empty fields may be omitted.

```
URL={{CHAT_URL}}
STEP=<free-form step identifier, optional>
TODO=<free-form todo identifier, optional>
TITLE=<short task title>
SCOPE_TOUCH=<files/dirs allowed to edit, comma-separated>
SCOPE_FORBID=<files/dirs forbidden to edit, comma-separated>
CONTEXT:
- <concise background bullets, optional>
CONSTRAINTS:
- <constraint 1>
- <constraint 2>
ACCEPTANCE:
- <criterion 1>
- <criterion 2>
DELIVERABLES:
- Unified patch/diffs (touch only SCOPE_TOUCH)
- Proposed Conventional Commit message
- Exactly one final section: `### Change Summary`
NOTES:
- Comments/docstrings in Slovak; report in English
- Determinism; no network in tests; skip UI/Qt tests on CI
- No new dependencies without explicit permission
- Do not run git commands; do not write secrets
```

**Rationale**
- `SCOPE_TOUCH` and `SCOPE_FORBID` prevent collateral edits.
- `CONSTRAINTS` and `ACCEPTANCE` are the contract.
- `STEP`/`TODO` are free‑form labels (no hard numbering needed).

**Minimal example**
```
#! Codex agent prompt
URL=https://chatgpt.com/c/xxxxxxxx
TITLE=Implement click-to-place with blank popup and judged confirmation
SCOPE_TOUCH=scrabgpt/ui/app.py,scrabgpt/ai/client.py
SCOPE_FORBID=scrabgpt/core/,tests/
CONSTRAINTS:
- Keep UI resizable; no breaking existing interactions
- Log OpenAI requests/responses with masked key
ACCEPTANCE:
- Blank popup A–Z; ghost score; judge batch; DW on center; bingo +50
- ruff/mypy --strict/pytest all green
DELIVERABLES:
- Unified patch/diffs
- Conventional Commit
- ### Change Summary
NOTES:
- No new deps; no git commands; Slovak comments
```

---

## 3) Worker → Orchestrator response (strict format)
Worker must respond in the following order. When something doesn’t apply, the section can be omitted (not replaced with placeholders).

1) **Unified Diffs** (touching only `SCOPE_TOUCH`), with clear file paths.
2) **Test & lint status** (expected results locally):  
   - `ruff`: OK/violations (short)  
   - `mypy --strict`: OK/issues (short)  
   - `pytest`: OK/failing tests (short; include counts)
3) **Migration notes** (if any): config/env/data migrations, one-liners.
4) **Known limitations & edge cases** (bullet list).
5) **Rollback plan** (how to revert the change set safely).
6) **Proposed Conventional Commit** (one line).
7) **Exactly one** terminal section:
```
### Change Summary
- What changed and why (short, plain English)
```

**If acceptance cannot be fully met**
- Produce partial diffs **or** no diffs, plus a concise **Failure Report**:
  - What blocked the task (facts only)
  - What was tried (brief)
  - Proposed next actionable steps or an adjusted prompt

**Hard requirements**
- No secrets in diffs or logs.
- Do not run git or system package managers.
- Respect `SCOPE_FORBID`. If a change is needed there, stop and request scope expansion.

---

## 4) Task design guidelines (Orchestrator rules)
- **Atomize** tasks: one capability at a time; avoid cross‑cutting refactors.
- **Pin interfaces**: schemas, params, and contracts stated explicitly.
- **Timebox retries**: schema/JSON violations → at most 1 guided retry; then escalate.
- **Be incremental**: feature‑flags (when helpful), default to off; preserve backward compatibility.
- **Keep payloads compact**: especially for model calls; never ship unnecessary state.
- **Determinism**: seed RNG; stable snapshot tests for pure logic.

---

## 5) Quality & safety rails
- **Dependencies**: adding or updating requires explicit approval in the prompt; otherwise use stdlib/existing libs.
- **Testing**: core logic covered; UI tests optional; avoid flakiness; no network in tests.
- **Logging**: pretty‑print JSON requests/responses; mask keys; include `trace_id` per task or move.
- **Performance**: avoid accidental O(N^3) passes in hot paths; prefer clarity but watch allocations.
- **Security**: never print `.env` contents; red‑flag any PII or secret handling in review.
- **Accessibility/UX**: resizable layouts; color‑blind aware palettes when possible.

---

## 6) Versioning & compatibility
- This spec is **AP1.0**. Include `AP1.0` in AGENTS.md so Worker knows the contract version.
- Future updates will be AP1.1, AP1.2, …; prompts may reference `AP_VERSION=AP1.0` explicitly.

---

## 7) Boot Prompt (to include in AGENTS.md)
> Use this exact section verbatim inside **AGENTS.md** so Codex Agent has a stable operating mode.

```
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
```

---

## 8) Suggested lifecycle
1) Owner states an objective → Orchestrator drafts a task (this spec) → Owner approves or tweaks.
2) Worker delivers diffs → Orchestrator reviews against **ACCEPTANCE** → Owner merges or requests follow‑ups.
3) Iterate with small steps until MVP criteria in **PRD.md** are met.

---
