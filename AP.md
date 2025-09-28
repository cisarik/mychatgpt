# Analytic Programming Protocol

> **Purpose.** Make collaboration between **Owner** (user), **Orchestrator** (ChatGPT), and **Worker** (Codex Agent) smooth, deterministic, and reviewable. This document standardizes task prompts, responses, scope control, and quality gates while staying lightweight.

---

## 0) Roles & responsibilities
- **Owner (user)**: sets product vision and priorities, approves scope, merges changes & test code
- **Orchestrator (ChatGPT)**: decomposes objectives into atomic tasks, drafts precise prompts and acceptance criteria, curates scope & constraints, reviews Worker results and describe how should Owner test the code in each step of the development.
- **Worker (Codex Agent)**: follows instructions of the Orchestrator and implements changes; reports back in the exact response format.

**Guiding principles**
- Small, reversible diffs; deterministic behavior; strict interfaces; no surprises.
- Tests before/with changes for core logic; UI tests are optional and skipped on CI.
- Minimize dependencies; never touch secrets; zero flakiness.
- Be explicit about **how the code should be edited** and **what is forbidden**.

---

## 1) Repository & artifacts (baseline)
- **PRD.md**: product requirements, always the single source of truth.
- **AP.md**: this protocol + the **Boot Prompt** and project‑specific rules.
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
STEP=<free-form step identifier>
TITLE=<short task title>
CONSTRAINTS:
- <constraint 1>
- <constraint 2>
ACCEPTANCE:
- <criterion 1>
- <criterion 2>
NOTES:
- Comments/docstrings in Slovak; report in English
- Determinism; no network in tests; skip UI/Qt tests on CI
- No new dependencies without explicit permission
- Do not write secrets
```

**Rationale**
- `CONSTRAINTS` and `ACCEPTANCE` are the contract.
- `STEP` are free‑form labels (no hard numbering needed).

**Minimal example**
```
#! Codex agent prompt
STEP=INIT
TITLE=Implement click-to-place with blank popup and judged confirmation
CONSTRAINTS:
- Keep UI resizable; no breaking existing interactions
- Log OpenAI requests/responses with masked key
ACCEPTANCE:
- Blank popup A–Z; ghost score; judge batch; DW on center; bingo +50
- ruff/mypy --strict/pytest all green
NOTES:
- No new deps; Slovak comments
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

**If acceptance cannot be fully met**
- Produce partial diffs **or** no diffs, plus a concise **Failure Report**:
  - What blocked the task (facts only)
  - What was tried (brief)
  - Proposed next actionable steps or an adjusted prompt

**Hard requirements**
- No secrets in diffs or logs.

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

## 6) Boot Prompt (to include in AGENTS.md)
> Use this exact section verbatim inside **AGENTS.md** so Codex Agent has a stable operating mode.

```
You are Worker agent operating under Analytic Programming protocol.
- Work in small, reviewable diffs.
- Comments/docstrings in Slovak; report in English.
- Deterministic behavior; no network in tests; skip UI/Qt tests on CI.
- Log model requests/responses (keys masked).

You will receive prompts whose **first line is**: `#! Codex agent prompt`.
Follow all fields that follow (TITLE, CONSTRAINTS, ACCEPTANCE, NOTES).
Return your response in the **Worker → Orchestrator** format defined by **AP.md**.
If acceptance cannot be met, stop, provide a Failure Report (facts only), and propose the next task.
```

---

## 8) Suggested lifecycle
1) Owner states an objective → Orchestrator drafts a task (this spec) → Owner approves or tweaks.
2) Worker delivers diffs → Orchestrator reviews against **ACCEPTANCE** → Owner merges or requests follow‑ups.
3) Iterate with small steps until MVP criteria in **PRD.md** are met.

---
