# MyChatGPT – Product Requirements Document (PRD)

**Project**: MyChatGPT (Chrome/Brave Extension, MV3)  
**Owner**: Michal  
**Orchestrator**: ChatGPT (GPT‑5 Thinking)  
**Worker**: Cursor Agent  
**Version**: 0.2.5‑reboot (2025‑09‑25)  

---

## 1) Účel a „one‑liner“
Rozšírenie pre Chrome/Brave, ktoré **udrží účet ChatGPT čistý**: heuristicky deteguje **krátke „search‑like“ konverzácie** vytvorené *oficiálnym ChatGPT Chrome/Brave rozšírením*, **lokálne ich zazálohuje** (IndexedDB ako HTML snapshot) a podľa nastavení ich **jemne skryje** cez `PATCH conversation/{id} {is_visible:false}` (tzv. soft‑delete). Všetko **lokálne**, bez cloudu.

---

## 2) Kontext a motivácia
- Krátke jednorazové hľadania nechceme mať uložené v histórii ChatGPT účtu.
- Potrebujeme mať možnosť používať **GPT‑4/5** bez „znečisťovania“ účtu, zároveň si ale **lokálne uchovať** mini‑zálohy (otázka + HTML odpoveď) pre neskoršie dohľadanie.
- Rozšírenie funguje **bez servera**: všetky dáta ostávajú u používateľa.

---

## 3) Ciele (Goals)
1. **Detekcia krátkych konverzácií** (default: ≤ 2 správy celkovo alebo ≤ 2 užívateľské správy).
2. **Lokálna záloha**: uložiť *innerHTML bubliny* (odpoveď) + otázku + timestamp + kategóriu.
3. **Možnosť soft‑delete** cez oficiálne API (ak je dostupné a oprávnené), **nikdy bez potvrdenia**, ak je tak nastavené.
4. **Prehľadné UI** v popupe: rýchle vyhľadávanie, kategorizácia, náhľad zálohy, export .html.
5. **Bezpečné defaulty**: nič neničíme bez jasného potvrdenia (LIST_ONLY, DRY_RUN, CONFIRM_BEFORE_DELETE) a s limtami (DELETE_LIMIT, cooldown).
6. **Audit/Debug**: čitateľný lokálny log posledných ~500 udalostí.

---

## 4) Neklady (Non‑Goals)
- Žiadne cloudové sync/backupy.
- Žiadny „hard‑delete“ účtových konverzácií (iba soft‑hide `is_visible:false`).
- Žiadna neautorizovaná manipulácia s konverzáciami mimo podporovaných oficiálnych endpointov.
- Žiadne prepisovanie originálneho UI ChatGPT (okrem minimálnych content‑skriptov, ak treba pre snapshoty).

---

## 5) Terminológia
- **Krátka konverzácia / search‑like chat**: Rozhovor s **MAX_MESSAGES=2** (celkovo) alebo **USER_MSG_MAX=2** (viď heuristika).  
- **Soft‑delete / soft‑hide**: PATCH `conversation/{id}` s `is_visible:false` (reverzibilné v účte, ak služba dovoľuje).  
- **Backup / záloha**: lokálny záznam (IndexedDB) obsahujúci meta + HTML odpoveď.

---

## 6) Personas & Scenáre
**Michal (power‑user, dev)**  
- Otvorí chat v oficiálnom ChatGPT rozšírení, položí krátku otázku („convert png→webp“), dostane odpoveď, zavrie.  
- MyChatGPT rozpozná „short“ chat, **uloží** lokálnu kópiu a podľa nastavení navrhne soft‑hide v účte.  
- Michal si neskôr otvorí popup, **vyhľadá** „webp“, otvorí zálohu, prípadne ju **exportuje .html**.

---

## 7) Základná hodnota / USP
- **Čistý účet** bez desiatok jednorazových minichatov.  
- **Plné súkromie**: zálohy sú **iba lokálne**.  
- **Reverzibilita**: v účte sa iba skryje (nie vymaže).  
- **Rýchle vyhľadanie** a kategorizácia mini‑výsledkov.

---

## 8) Hlavné funkcie (Functional Requirements)
### 8.1 Heuristická detekcia „short chats“
- Po otvorení/aktivácii **chatgpt.com** sa spustí **auto‑scan** (ak je ON) s **cooldownom 5 min**.  
- Získať zoznam konverzácií cez oficiálne API (viď §13).  
- Pre každú konverzáciu načítať prehľad (title, id, count).  
- **Heuristika SHORT** (default):
  - `MAX_MESSAGES = 2` (celkovo) **a zároveň** `USER_MESSAGES_MAX = 2` (nikdy neakceptovať >2 user správy),
  - `MIN_AGE_MINUTES = 2` (nikdy nezasahovať do čerstvých konverzácií),
  - `SAFE_URL_PATTERNS` (napr. `/workspaces`, `/projects`, `/new-project`) → **nikdy nezasahovať**.
- Ak konverzácia spĺňa pravidlá → **Backup** → (voliteľne) **soft‑hide**.

### 8.2 Lokálna záloha (IndexedDB)
- Ukladať do DB **mychatgpt-db**:
  - **stores**:
    - `backups { id (PK, uuid), title, questionText, answerHTML, timestamp, category, convoId }`
    - `categories { id, name }` (seed: *Programovanie, Kryptomeny, HW, Zdravie*)
- **answerHTML** = `innerHTML` bubliny/obsahu odpovede ChatGPT (minimalne čisté, ale vernú kópiu pre offline zobrazenie).  
- `questionText` = prvá otázka používateľa (alebo relevantný „search term“).  
- `category` = presne **jedna** kategória (nie viacnásobné tagy); správa kategórií **dynamická** (pridať/premenovať/odstrániť).  
- Export jednej zálohy ako **`<title>-<timestamp>.html`** (obsahuje otázku + HTML odpoveď + jednoduchý CSS pre čitateľnosť).

### 8.3 Soft‑hide (PATCH is_visible:false)
- Až po **explicitnom potvrdení**, pokiaľ `CONFIRM_BEFORE_DELETE = true` (default).  
- `DRY_RUN = true` (default) → ukáž, čo by sa stalo, ale **neodosielaj PATCH**.  
- `LIST_ONLY = true` (hard‑safe default) → nikdy neodosielať PATCH bez ručnej zmeny v Settings.
- `DELETE_LIMIT = 10` na jednu dávku (scan), aby sa predišlo hromadným chybám.

### 8.4 UI (popup + pages)
**Popup (default)**
- Pole **Search** (full‑text nad `title` + `questionText`).  
- Tab **Searches** (tabuľkový zoznam záloh).  
- Tab **Backup** (náhľad záznamu + tlačidlá Export/Set category/Delete from local DB).  
- Tab **Settings** (prepínače & parametre).  
- Tab **Debug** (živé logy, „Scan now“).  

**Settings** (detaily v §10)
- LIST_ONLY, DRY_RUN, CONFIRM_BEFORE_DELETE, AUTO_SCAN, COOLDOWN_MIN, MAX_MESSAGES, USER_MESSAGES_MAX, MIN_AGE_MINUTES, DELETE_LIMIT, SAFE_URL_PATTERNS (CSV),
- Správa kategórií (CRUD).

**Backup viewer**
- Bezpečné zobrazenie uloženého `answerHTML` v sandboxe (iframe / sanitizované),
- Zobrazenie `questionText`, `timestamp`, `convoId`, `category`.

**Debug**
- Posledných 500 log záznamov (s časom), filter, kopírovanie, **Export debug** (JSON/plain).

### 8.5 Logovanie
- `chrome.storage.local.debug_logs` (FIFO, limit 500).  
- Každý log event má `ts`, `level`, `scope`, `msg`, `meta` (napr. convoId, counts, endpoint response status).

---

## 9) Ne-funkčné požiadavky (NFR)
- **Súkromie**: žiadny cloud, všetko lokálne. Žiadne posielanie obsahu mimo ChatGPT API, ktoré používateľ už využíva.
- **Bezpečnosť**: sandboxované rendrovanie HTML; minimálne host permissions (iba `https://chatgpt.com/*`).
- **Výkon**: scan s cooldownom; žiadne ephemerálne okná; bez ťažkých DOM operácií.
- **Stabilita**: limiter PATCH volaní, retry s backoff (max 2×).  
- **DX/Údržba**: čistý modulárny kód; bohaté komentáre v EN; README/Agent.md.

---

## 10) Nastavenia (Settings) – presné polia
- **LIST_ONLY** *(bool, default: true)* – Vynúti read‑only režim (prepíše všetko ostatné; nikdy neodosiela PATCH).
- **DRY_RUN** *(bool, default: true)* – Simulácia PATCH; vypíše, čo by sa stalo.
- **CONFIRM_BEFORE_DELETE** *(bool, default: true)* – Pred každým PATCH zobraziť potvrdenie.
- **AUTO_SCAN** *(bool, default: true)* – Automaticky skenovať pri otvorení/aktivácii chatgpt.com.
- **COOLDOWN_MIN** *(int, default: 5)* – Minúty medzi automatickými scanmi.
- **MAX_MESSAGES** *(int, default: 2)* – Max celkový počet správ v konverzácii pre kvalifikáciu.
- **USER_MESSAGES_MAX** *(int, default: 2)* – Max počet užívateľských správ; ak >2, nikdy nedeletovať.
- **MIN_AGE_MINUTES** *(int, default: 2)* – Minimálny vek konverzácie pred zásahom.
- **DELETE_LIMIT** *(int, default: 10)* – Max počet PATCH na jednu dávku.
- **SAFE_URL_PATTERNS** *(string CSV)* – napr. `/workspaces,/projects,/new-project`.
- **Categories Manager** – CRUD s default „Programovanie, Kryptomeny, HW, Zdravie“.

---

## 11) UX / UI špecifikácia
### 11.1 Navigácia
- **Popup**: horná nav s tabs: *Searches · Backup · Settings · Debug*.
- **Search field** v hlavičke; okamžitý filter.

### 11.2 Searches
- Tabuľka: `Title` · `Question` (truncate) · `Category` · `Timestamp` · `Open`.
- Klik na `Open` → prechod do **Backup** s náhľadom.

### 11.3 Backup
- Panel s metadátami + sandboxovaný náhľad odpovede.  
- Tlačidlá: **Export .html**, **Set category**, **Delete local**.

### 11.4 Settings
- Skupiny: *Safety*, *Heuristics*, *Automation*, *Categories*, *API* (read‑only info), *About*.
- Spínače + sliders + inputy.  
- **Scan now** tlačidlo (volá runner bez cooldownu).

### 11.5 Debug
- Live log (auto‑scroll, pause), filter podľa `level/scope`.  
- **Export debug** (stiahnuť JSON/plain).

---

## 12) Architektúra a súbory
**Manifest v3**  
**Permissions**: `offscreen`, `alarms`, `tabs`, `scripting`, `storage`, `clipboardRead`, `clipboardWrite`, `notifications`  
**Host permissions**: `https://chatgpt.com/*`

**Súbory**
- `manifest.json`
- `background.js` (service worker) – runner, auto‑scan, API klient, limiter, storage prístup.
- `content.js` – extrakcia `questionText` a `answerHTML` pri potrebe, identifikácia bublín.
- `db.js` – IndexedDB wrapper (mychatgpt-db), stores „backups“, „categories“.
- `utils.js` – helpery (logging, formatting, CSV ↔ array, retry/backoff, sanitizácia HTML).
- `styles.css` – minimalistické UI + dark‑mode podpora.
- **Pages**: `popup.html`, `popup.js` · `searches.html/js` · `backup.html/js` · `settings.html/js` · `debug.html/js`.

**UI štýl**: moderný, čistý, *sleek*, dark‑mode aware.

---

## 13) API ChatGPT (konverzačné)
> Pozn.: Použiť oficiálne koncové body, ktoré používa webové rozhranie. Názvy sú orientačné.

- **GET** `/conversations` – stránkovaný zoznam (id, title, create_time, update_time, message_count...).
- **GET** `/conversation/{id}` – detail a počty správ (pre heuristiku a extrakciu otázky/odpovede, ak nie sú v DOMe dostupné).
- **PATCH** `/conversation/{id}` body: `{ is_visible:false }` – soft‑hide.  
- **Bezpečnostné zásady**: iba s aktívnou user session v prehliadači, žiadne tokeny neukladáme mimo storage prehliadača; rešpektovať CORS a fetch politiku.

---

## 14) Heuristika – presné pravidlá a pseudokód
```js
function qualifiesShortChat(meta, settings) {
  const {
    MAX_MESSAGES = 2,
    USER_MESSAGES_MAX = 2,
    MIN_AGE_MINUTES = 2,
    SAFE_URL_PATTERNS = []
  } = settings;

  if (meta.url && SAFE_URL_PATTERNS.some(p => meta.url.includes(p))) return false;
  if (minutesSince(meta.updatedAt) < MIN_AGE_MINUTES) return false;
  if (meta.totalMessages > MAX_MESSAGES) return false;
  if (meta.userMessages > USER_MESSAGES_MAX) return false;
  return true;
}
```

**Runner flow**
```mermaid
flowchart TD
  A[Activation chatgpt.com] --> B{AUTO_SCAN?}
  B -- no --> Z[Stop]
  B -- yes --> C[Cooldown passed?]
  C -- no --> Z
  C -- yes --> D[Fetch conversations]
  D --> E[Filter qualifiesShortChat]
  E --> F[Backup locally]
  F --> G{LIST_ONLY?}
  G -- yes --> Z
  G -- no --> H{DRY_RUN?}
  H -- yes --> I[Show would‑patch summary]
  H -- no --> J{CONFIRM_BEFORE_DELETE?}
  J -- yes --> K[Show confirm dialog]
  J -- no --> L[PATCH is_visible:false (<= DELETE_LIMIT)]
  K -->|confirmed| L
  K -->|cancel| Z
  L --> Z
```

---

## 15) Dáta a schéma (IndexedDB)
**DB**: `mychatgpt-db`

**Store `backups`**
- `id: string` (uuid v4)
- `convoId: string`
- `title: string`
- `questionText: string`
- `answerHTML: string`
- `timestamp: number` (ms since epoch)
- `category: string` (FK → categories.name, no‑cascade)

**Store `categories`**
- `id: string` (uuid)
- `name: string` (unique)

**Indexy**: `backups.title`, `backups.questionText`, `backups.timestamp`, `backups.category`.

---

## 16) Bezpečnosť & Súkromie
- **Žiadny cloud** – iba local storage/IndexedDB.  
- Render `answerHTML` v **sandbox iframe** s CSP (bez skriptov).  
- Žiadne externé requesty mimo chatgpt.com hosta.  
- **Export .html** je plain súbor na disku používateľa.

---

## 17) Výkon & Spoľahlivosť
- Cooldown auto‑scanu (default 5 min).  
- `DELETE_LIMIT` na batch PATCH.  
- Retry/backoff 200ms/400ms (max 2×) pri `429/5xx`.  
- Fail‑safe: ak API zlyhá → iba log, nikdy nekorumpuj DB.

---

## 18) Prístupnosť (a11y) & i18n
- Klávesové skratky v popupe, focus order, kontrast.  
- Základná i18n infra (en/sk súbory stringov).  
- Default UI texty v EN, pre Michala SK.

---

## 19) Telemetria
- **Žiadna** externá; iba lokálny debug log.

---

## 20) Testovanie & QA
- Jednotkové testy utilít (kde možné v MV3 prostredí).  
- Manuálne scenáre:
  1. Short chat (1 Q + 1 A) → backup OK → DRY_RUN zobrazuje návrh PATCH.  
  2. Long chat (>2 user msgs) → nikdy nenavrhnúť delete.  
  3. MIN_AGE_MINUTES guard → čerstvý chat sa neberie.  
  4. SAFE_URL_PATTERNS guard.  
  5. DELETE_LIMIT dodržaný.  
  6. Export .html funkčný (otvoriteľný offline).  
  7. Kategórie CRUD.  
  8. Dark mode UI.

---

## 21) Release plán
- **v0.2.5‑reboot**: baseline heuristika + backup + UI tabs + DRY_RUN + LIST_ONLY.  
- **v0.3.x**: vylepšená extrakcia `questionText`/`answerHTML` (fallback DOM→API), hromadný confirm dialog s náhľadmi.
- **v0.4.x**: pokročilá filtrácia a rýchle akcie v Searches; multi‑export.  
- **v0.5.x**: voliteľné pravidlá podľa dĺžky `answerHTML`, času čítania, a pod.

---

## 22) Riziká & mitigácie
- **Zmeny interných API chatgpt.com** → robustný detektor chýb, feature flags, rýchle hotfixy.
- **CSP/Sandbox** pri rendrovaní HTML → iframe sandbox + sanitizácia.
- **Mylná heuristika** → LIST_ONLY + DRY_RUN default, CONFIRM always on.

---

## 23) Otvorené otázky
1. Potvrdiť definitívny zoznam SAFE_URL_PATTERNS a ich predvyplnenie.  
2. Presné hlavičky/endpointy aktuálneho web API (možná zmena v čase).  
3. Pridať voliteľný „Undo last batch“ (iba lokálne – re‑PATCH is_visible:true ak API dovolí?).

---

## 24) Akceptačné kritériá (MVP v0.2.5‑reboot)
- A1: Po aktivácii chatgpt.com a uplynutí COOLDOWN sa vykoná scan.  
- A2: Konverzácia s 1–2 správami (a ≤2 user msgs), staršia ako 2 min, **bude zazálohovaná** do IndexedDB.  
- A3: V LIST_ONLY+DRY_RUN režime zobrazí rozšírenie v Debug prehľad „čo by skrylo“; **nič sa neskrýva**.  
- A4: V Settings možno vypnúť LIST_ONLY a DRY_RUN; pri CONFIRM=true sa zobrazí dialóg a po potvrdení sa odošle PATCH (≤ DELETE_LIMIT).  
- A5: Popup umožní hľadať v zálohách, otvoriť náhľad a exportovať .html.  
- A6: Kategórie sú CRUD a presne jedna na záznam.

---

## 25) Dokumentácia & súbory v projekte
- **README.md (EN)** – dôvod vzniku, lokálne zálohy, inštalácia, nastavenia.  
- **Agent.md (Cursor)** – postup pre Worker agenta v Cursor IDE, príkazy, build, test, balenie ZIP.  
- Bohaté komentáre v zdrojových kódoch (EN), aby boli čitateľné pre komunitu.

---

## 26) Prílohy
### 26.1 Wireframe – Popup
- Header: Search | Tabs: Searches | Backup | Settings | Debug.  
- Searches: Table + paginator, detail → Backup.  
- Backup: Meta + iframe preview + Export/Category/Delete (local).  
- Settings: Safety (LIST_ONLY, DRY_RUN, CONFIRM), Heuristics (MAX, USER_MAX, MIN_AGE), Automation (AUTO_SCAN, COOLDOWN), Categories CRUD, Debug actions.  
- Debug: log viewer, Export.

### 26.2 Log štruktúra (JSON)
```json
{
  "ts": 1695650000000,
  "level": "info|warn|error|debug",
  "scope": "runner|api|db|ui",
  "msg": "Fetched conversations",
  "meta": {"count": 23}
}
```

### 26.3 Export .html – minimálna šablóna
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{{title}} – {{ts}}</title>
  <style>body{max-width:880px;margin:2rem auto;font:16px/1.5 system-ui} .q{opacity:.8;margin:1rem 0} .a{border:1px solid #ddd;padding:1rem;border-radius:12px;overflow:auto}</style>
</head>
<body>
  <h1>{{title}}</h1>
  <p class="q"><strong>Question:</strong> {{questionText}}</p>
  <section class="a">{{{answerHTML}}}</section>
  <footer><small>Exported from MyChatGPT · {{ts}}</small></footer>
</body>
</html>
```

---

**Koniec PRD**

