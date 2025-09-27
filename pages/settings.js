/* Slovensky komentar: Nastavenia sa viazu cez mapu poli a idempotentne load/save/reset helpery. */
(async function () {
  const SETTINGS_KEY = 'settings_v1';
  const form = document.getElementById('settings-form');
  const toastHost = document.getElementById('settings-toast');
  const statusText = document.getElementById('status-text');

  const FIELDS = {
    LIST_ONLY: { sel: '#LIST_ONLY', type: 'bool' },
    DRY_RUN: { sel: '#DRY_RUN', type: 'bool' },
    CONFIRM_BEFORE_DELETE: { sel: '#CONFIRM_BEFORE_DELETE', type: 'bool' },
    AUTO_SCAN: { sel: '#AUTO_SCAN', type: 'bool' },
    SHOW_CANDIDATE_BADGE: { sel: '#SHOW_CANDIDATE_BADGE', type: 'bool' },
    CAPTURE_ONLY_CANDIDATES: { sel: '#CAPTURE_ONLY_CANDIDATES', type: 'bool' },
    MAX_MESSAGES: { sel: '#MAX_MESSAGES', type: 'int' },
    USER_MESSAGES_MAX: { sel: '#USER_MESSAGES_MAX', type: 'int' },
    SCAN_COOLDOWN_MIN: { sel: '#SCAN_COOLDOWN_MIN', type: 'int' },
    MIN_AGE_MINUTES: { sel: '#MIN_AGE_MINUTES', type: 'int' },
    DELETE_LIMIT: { sel: '#DELETE_LIMIT', type: 'int' },
    SAFE_URL_PATTERNS: { sel: '#SAFE_URL_PATTERNS', type: 'multiline' }
  };

  if (!form) {
    console.error('Settings form element missing');
    return;
  }

  const healHints = new Map();
  document.querySelectorAll('.heal-hint').forEach((element) => {
    healHints.set(element.dataset.field, element);
  });

  /* Slovensky komentar: Pripravi toast notifikaciu. */
  function toast(message) {
    if (!toastHost) {
      return;
    }
    toastHost.textContent = '';
    if (!message) {
      return;
    }
    const toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.textContent = message;
    toastHost.appendChild(toastEl);
    setTimeout(() => {
      if (toastEl.parentElement === toastHost) {
        toastHost.removeChild(toastEl);
      }
    }, 2600);
  }

  /* Slovensky komentar: Nastavi textovy status pre pouzivatela. */
  function setStatus(message) {
    if (statusText) {
      statusText.textContent = message || '';
    }
  }

  /* Slovensky komentar: Resetuje hinty oprav na skryte. */
  function renderHealedHints(fields) {
    const allowed = Array.isArray(fields) ? new Set(fields) : new Set();
    healHints.forEach((element, key) => {
      element.hidden = !allowed.has(key);
    });
  }

  /* Slovensky komentar: Vrati hlboku kopiu predvolenych nastaveni. */
  function createDefaultSnapshot() {
    const base = typeof SETTINGS_DEFAULTS === 'object' && SETTINGS_DEFAULTS
      ? SETTINGS_DEFAULTS
      : {
          LIST_ONLY: true,
          DRY_RUN: true,
          CONFIRM_BEFORE_DELETE: true,
          AUTO_SCAN: false,
          SHOW_CANDIDATE_BADGE: true,
          MAX_MESSAGES: 2,
          USER_MESSAGES_MAX: 2,
          SCAN_COOLDOWN_MIN: 5,
          MIN_AGE_MINUTES: 2,
          DELETE_LIMIT: 10,
          CAPTURE_ONLY_CANDIDATES: true,
          SAFE_URL_PATTERNS: [
            '/workspaces',
            '/projects',
            '/new-project',
            'https://chatgpt.com/c/*'
          ]
        };
    const safeArray = Array.isArray(base.SAFE_URL_PATTERNS) ? base.SAFE_URL_PATTERNS : [];
    return {
      ...base,
      SAFE_URL_PATTERNS: [...safeArray]
    };
  }

  /* Slovensky komentar: Bezpecne normalizuje SAFE_URL vstup. */
  function normalizePatterns(input) {
    if (typeof normalizeSafeUrlPatterns === 'function') {
      return normalizeSafeUrlPatterns(input);
    }
    const maxLength = 200;
    const seen = new Set();
    const items = Array.isArray(input)
      ? input
      : typeof input === 'string'
      ? input.split(/\r?\n/)
      : [];
    const normalized = [];
    items.forEach((rawLine) => {
      if (typeof rawLine !== 'string') {
        return;
      }
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.length > maxLength) {
        return;
      }
      if (seen.has(trimmed)) {
        return;
      }
      seen.add(trimmed);
      normalized.push(trimmed);
    });
    return normalized;
  }

  /* Slovensky komentar: Nacita cerstve nastavenia zo storage. */
  async function loadSettingsFresh() {
    const defaults = createDefaultSnapshot();
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      const raw = stored && typeof stored[SETTINGS_KEY] === 'object' ? stored[SETTINGS_KEY] : null;
      if (!raw) {
        return defaults;
      }
      if (typeof SettingsStore === 'object' && typeof SettingsStore.sanitize === 'function') {
        const { settings } = SettingsStore.sanitize(raw);
        const sanitized = {
          ...defaults,
          ...settings
        };
        const normalizedPatterns = normalizePatterns(settings.SAFE_URL_PATTERNS);
        sanitized.SAFE_URL_PATTERNS = normalizedPatterns.length ? normalizedPatterns : [...defaults.SAFE_URL_PATTERNS];
        return sanitized;
      }
      const merged = {
        ...defaults,
        ...raw
      };
      ['LIST_ONLY', 'DRY_RUN', 'CONFIRM_BEFORE_DELETE', 'AUTO_SCAN', 'SHOW_CANDIDATE_BADGE', 'CAPTURE_ONLY_CANDIDATES'].forEach((key) => {
        if (typeof raw[key] === 'boolean') {
          merged[key] = raw[key];
        } else {
          merged[key] = defaults[key];
        }
      });
      ['MAX_MESSAGES', 'USER_MESSAGES_MAX', 'SCAN_COOLDOWN_MIN', 'MIN_AGE_MINUTES', 'DELETE_LIMIT'].forEach((key) => {
        const value = Number(raw[key]);
        merged[key] = Number.isFinite(value) && value >= 1 ? Math.floor(value) : defaults[key];
      });
      const normalizedPatterns = normalizePatterns(raw.SAFE_URL_PATTERNS ?? merged.SAFE_URL_PATTERNS);
      merged.SAFE_URL_PATTERNS = normalizedPatterns.length ? normalizedPatterns : [...defaults.SAFE_URL_PATTERNS];
      return merged;
    } catch (error) {
      console.error('loadSettingsFresh failed', error);
      return defaults;
    }
  }

  /* Slovensky komentar: Prenesie nastavenia do formulara. */
  function renderSettings(settings) {
    if (!settings) {
      return;
    }
    Object.entries(FIELDS).forEach(([key, def]) => {
      const element = document.querySelector(def.sel);
      if (!element) {
        return;
      }
      switch (def.type) {
        case 'bool':
          element.checked = !!settings[key];
          break;
        case 'int':
          element.value = Number(settings[key] ?? 0);
          break;
        case 'multiline':
          element.value = Array.isArray(settings[key]) ? settings[key].join('\n') : '';
          break;
        default:
          break;
      }
    });
  }

  /* Slovensky komentar: Precita hodnoty z formulara do objektu. */
  function readFormValues() {
    const output = {};
    Object.entries(FIELDS).forEach(([key, def]) => {
      const element = document.querySelector(def.sel);
      if (!element) {
        return;
      }
      switch (def.type) {
        case 'bool':
          output[key] = !!element.checked;
          break;
        case 'int':
          {
            const rawNumber = Number(element.value);
            const safeNumber = Math.max(1, Number.isFinite(rawNumber) ? rawNumber : 1);
            output[key] = Math.floor(safeNumber);
          }
          break;
        case 'multiline':
          output[key] = normalizePatterns(element.value);
          break;
        default:
          break;
      }
    });
    return output;
  }

  /* Slovensky komentar: Porovna konfiguracie a vybuduje diff. */
  function diffSettings(previous, next) {
    const diff = {};
    const keys = new Set([
      ...Object.keys(previous || {}),
      ...Object.keys(next || {})
    ]);
    keys.forEach((key) => {
      const beforeValue = previous ? previous[key] : undefined;
      const afterValue = next ? next[key] : undefined;
      const equal = Array.isArray(beforeValue)
        ? Array.isArray(afterValue)
          && beforeValue.length === afterValue.length
          && beforeValue.every((value, index) => value === afterValue[index])
        : beforeValue === afterValue;
      if (!equal) {
        diff[key] = { old: beforeValue, new: afterValue };
      }
    });
    return diff;
  }

  /* Slovensky komentar: Bezpecne zaloguje udalost. */
  async function logEvent(level, message, meta) {
    if (!level || !message || typeof Logger !== 'object' || typeof Logger.log !== 'function') {
      return;
    }
    try {
      await Logger.log(level, 'settings', message, meta);
    } catch (error) {
      console.warn('Logger.log failed', error);
    }
  }

  /* Slovensky komentar: Ulozi nastavenia do storage. */
  async function saveSettings(nextPartial) {
    try {
      const previous = await loadSettingsFresh();
      const next = {
        ...previous,
        ...nextPartial
      };
      next.SAFE_URL_PATTERNS = Array.isArray(next.SAFE_URL_PATTERNS) ? next.SAFE_URL_PATTERNS : [];
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      const changes = diffSettings(previous, next);
      await logEvent('info', 'Settings saved', { scope: 'settings', diff: changes, before: previous, after: next });
      toast('Uložené');
      setStatus('Nastavenia uložené.');
      renderHealedHints([]);
      renderSettings(next);
      return next;
    } catch (error) {
      console.error('saveSettings failed', error);
      toast('Uloženie zlyhalo');
      setStatus('Uloženie zlyhalo.');
      await logEvent('error', 'Settings save failed', { message: error && error.message });
      return null;
    }
  }

  /* Slovensky komentar: Resetuje nastavenia na predvolene hodnoty. */
  async function resetToDefaults() {
    const previous = await loadSettingsFresh();
    const defaults = createDefaultSnapshot();
    try {
      await chrome.storage.local.set({ [SETTINGS_KEY]: defaults });
      const next = await loadSettingsFresh();
      const changes = diffSettings(previous, next);
      await logEvent('info', 'Settings reset to defaults', { scope: 'settings', diff: changes, before: previous, after: next });
      toast('Obnovené na defaulty');
      setStatus('Predvolené hodnoty boli obnovené.');
      renderHealedHints([]);
      renderSettings(next);
      return next;
    } catch (error) {
      console.error('resetToDefaults failed', error);
      toast(`Reset zlyhal: ${(error && error.message) || 'unknown'}`);
      setStatus('Reset zlyhal.');
      await logEvent('error', 'Settings reset failed', { message: error && error.message });
      return null;
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = readFormValues();
    await saveSettings(values);
  });

  const resetButton = document.getElementById('reset-btn');
  if (resetButton) {
    resetButton.addEventListener('click', async () => {
      await resetToDefaults();
    });
  }

  const initialSettings = await loadSettingsFresh();
  renderSettings(initialSettings);
  renderHealedHints([]);
  setStatus('');
})();
