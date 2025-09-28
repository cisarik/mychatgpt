# MyChatGPT – Product Requirements Document (PRD)

**Project**: MyChatGPT (Chrome/Brave Extension, MV3)  
**Owner**: Michal  
**Orchestrator**: ChatGPT (GPT‑5 Thinking)  
**Worker**: GPT-5-Codex  

---

## 1) Účel a „one‑liner“
Rozšírenie pre Chrome/Brave, ktoré **udrží účet ChatGPT čistý**: heuristicky deteguje **krátke „search‑like“ konverzácie** vytvorené *oficiálnym ChatGPT Chrome/Brave rozšírením*, **lokálne ich zazálohuje** (IndexedDB ako HTML snapshot) a zmaže ich z chatgpt.com účtu ktorým je user prihlásený

---

## 2) Kontext a motivácia
- Krátke jednorazové hľadania nechceme mať uložené v histórii ChatGPT účtu.
- Potrebujeme mať možnosť používať **GPT‑5** bez „znečisťovania“ účtu, zároveň si ale **lokálne uchovať** mini‑zálohy (otázka + HTML odpoveď) pre neskoršie dohľadanie.
- Rozšírenie funguje **bez servera**: všetky dáta ostávajú u používateľa.

---

## 3) Ciele (Goals)
1. **Detekcia krátkych konverzácií** (default: ≤ 2 správy celkovo).
2. **Lokálna záloha**: uložiť *innerHTML bubliny* (odpoveď) + otázku + timestamp + kategóriu.
3. **Možnosť soft‑delete** cez oficiálne API (ak je dostupné a oprávnené), **nikdy bez potvrdenia**, ak je tak nastavené.
4. **Prehľadné UI** v popupe: rýchle vyhľadávanie, kategorizácia, náhľad zálohy, export .html.
5. **Bezpečné defaulty**: nič neničíme bez jasného potvrdenia (CONFIRM_BEFORE_DELETE)
6. **Audit/Debug**: čitateľný lokálny log posledných ~500 udalostí.

---

## 4) Neklady (Non‑Goals)
- Žiadne cloudové sync/backupy.
- Žiadne prepisovanie originálneho UI ChatGPT (okrem minimálnych content‑skriptov, ak treba pre snapshoty).

---

## 5) Terminológia
- **Krátka konverzácia / search‑like chat**: Rozhovor s **MAX_MESSAGES=2** (celkovo) (viď heuristika).  
- **Backup / záloha**: lokálny záznam (IndexedDB) obsahujúci *innerHTML* (odpoveď) + otázku + timestamp + kategóriu

---

## 6) Personas & Scenáre
**Michal (power‑user, dev)**  
- Otvorí MyChatGPT a vyberie s dropdownu **kategóriu**
- Otvorí chatgpt.com, položí krátku otázku („convert png→webp“), dostane odpoveď, zavrie/prepne na iný tab.  
- MyChatGPT rozpozná „short“ **search-like** chat, **uloží** lokálnu kópiu, pridelí jej vybratú **kategóriu** a konverzáciu vymaže z prihláseného účtu chatgpt.com: urobí to tak, ŽE SI INTERNE OTVORÍ chatgpt.com V SIDEBARE JU NÁJDE PODĽA TITLE, KTORÉ SI MYCHATGPT ULOŽIL PRI ROZPOZNANÍ A SIMULOVANÍM KLIKU NA DELETE A POTVRDENIE KLIKU NA DELETE JU Z ÚČTU VYMAŽE A ZMAZANIE SIGNALIZUJE USEROVI
- Michal si neskôr otvorí popup MyChatGPT, **vyhľadá** „webp“, zobrazi sa mu „convert png→webp“ link ktorým otvorí zálohu. **search-like** konverzácia sa už nenáchádza v jeho účte chatgpt.com 

---

## 7) Základná hodnota / USP
- **Čistý účet** bez desiatok jednorazových minichatov.  
- **Plné súkromie**: zálohy sú **iba lokálne**.   
- **Rýchle vyhľadanie** a kategorizácia mini‑výsledkov.

---

## 8) Hlavné funkcie (Functional Requirements)
### 8.1 Heuristická detekcia „short chats“
- Po otvorení/aktivácii **chatgpt.com** sa spustí **auto‑scan**.  
- Pre každú konverzáciu načítať prehľad (title, id, count).  
- **Heuristika SHORT** (default):
  - `MAX_MESSAGES = 2` (celkovo) nikdy neakceptovať >2 správy,
  - `SAFE_URL_PATTERNS` (napr. `/workspaces`, `/projects`, `/codex`) → **nikdy nezasahovať**.
- Ak konverzácia spĺňa pravidlá → **Backup**

### 8.2 Lokálna záloha (IndexedDB)
- Ukladať do DB **mychatgpt-db**:
  - **stores**:
    - `backups { id (PK, uuid), title, questionText, answerHTML, timestamp, category, convoId }`
    - `categories { id, name }` (seed: *Programovanie, Kryptomeny, HW, Zdravie*)
- **answerHTML** = `innerHTML` bubliny/obsahu odpovede ChatGPT (minimalne čisté, ale vernú kópiu pre offline zobrazenie).  
- `questionText` = prvá otázka používateľa (alebo relevantný „search term“).  
- `category` = presne **jedna** kategória (nie viacnásobné tagy); správa kategórií **dynamická** (pridať/premenovať/odstrániť).  
- Export jednej zálohy ako **`<title>-<timestamp>.html`** (obsahuje otázku + HTML odpoveď + jednoduchý CSS pre čitateľnosť).


### 8.4 UI (popup + pages)
**Popup (default)**
- Pole **Search** (zoznam záloh ktorým sa dá otvoriť záznam kliknutím na `questionText` zálohy).    
- Tab **Settings** (prepínače & parametre).  
- Tab **Debug** („Scan now“ a priestor na debug tlačidlá - debug výpisy sú v javascript console browsera).  

**Settings** (detaily v §10)
- DRY_RUN, AUTO_SCAN, MAX_MESSAGES
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
- **Súkromie**: žiadny cloud, všetko lokálne. Žiadne posielanie obsahu mimo ChatGPT, ktoré používateľ už využíva.
- **Bezpečnosť**: sandboxované rendrovanie HTML; minimálne host permissions (iba `https://chatgpt.com/*`).
- **Výkon**: scan s cooldownom; žiadne ephemerálne okná; bez ťažkých DOM operácií.
- **Stabilita**: limiter PATCH volaní, retry s backoff (max 2×).  
- **DX/Údržba**: čistý modulárny kód; bohaté komentáre v EN; README/AGENTS.md.

---

**Koniec PRD**

