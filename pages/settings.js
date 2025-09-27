/* Slovensky komentar: Stranka nastaveni pracuje so storage, normalizuje SAFE URL a obsluhuje ulozenie/reset. */
(async function () {
  const SETTINGS_KEY = 'settings_v1';
  const form = document.getElementById('settings-form');
  const statusText = document.getElementById('status-text');
  const toastHost = document.getElementById('settings-toast');
  const healHints = new Map();
  document.querySelectorAll('.heal-hint').forEach((element) => {
    healHints.set(element.dataset.field, element);
  });

  const defaultsFactory = typeof SettingsStore === 'object' && typeof SettingsStore.defaults === 'function'
    ? () => SettingsStore.defaults()
    : () => ({ SAFE_URL_PATTERNS: [] });
  const sanitizeFn = typeof SettingsStore === 'object' && typeof SettingsStore.sanitize === 'function'
    ? SettingsStore.sanitize
    : (raw) => ({ settings: defaultsFactory(), healedFields: [] });
  const normalizeFn = typeof normalizeSafeUrlPatterns === 'function'
    ? normalizeSafeUrlPatterns
    : (value) => ({
      patterns: Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [],
      fixed: false
    });

  let currentSettings = defaultsFactory();

  /* Slovensky komentar: Zobrazi kratku toast notifikaciu. */
  function showToast(message) {
    if (!toastHost) {
      return;
    }
    toastHost.textContent = '';
    if (!message) {
      return;
    }
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastHost.appendChild(toast);
    setTimeout(() => {
      if (toast.parentElement === toastHost) {
        toastHost.removeChild(toast);
      }
    }, 2600);
  }

  /* Slovensky komentar: Aktualizuje zobrazovanie hintov pre automaticke opravy. */
  function renderHealedHints(fields) {
    const allowed = Array.isArray(fields) ? new Set(fields) : new Set();
    healHints.forEach((element, key) => {
      element.hidden = !allowed.has(key);
    });
  }

  /* Slovensky komentar: Nastavi statusovu hlasku pre pouzivatela. */
  function setStatus(message) {
    if (statusText) {
      statusText.textContent = message || '';
    }
  }

  /* Slovensky komentar: Vyplni formular hodnotami z nastaveni. */
  function populateForm(settings) {
    form.LIST_ONLY.checked = Boolean(settings.LIST_ONLY);
    form.DRY_RUN.checked = Boolean(settings.DRY_RUN);
    form.CAPTURE_ONLY_CANDIDATES.checked = Boolean(settings.CAPTURE_ONLY_CANDIDATES);
    form.CONFIRM_BEFORE_DELETE.checked = Boolean(settings.CONFIRM_BEFORE_DELETE);
    form.AUTO_SCAN.checked = Boolean(settings.AUTO_SCAN);
    form.MAX_MESSAGES.value = Number(settings.MAX_MESSAGES || 0);
    form.USER_MESSAGES_MAX.value = Number(settings.USER_MESSAGES_MAX || 0);
    form.SCAN_COOLDOWN_MIN.value = Number(settings.SCAN_COOLDOWN_MIN || 0);
    const patterns = Array.isArray(settings.SAFE_URL_PATTERNS) ? settings.SAFE_URL_PATTERNS : [];
    form.SAFE_URL_PATTERNS.value = patterns.join('\n');
  }

  /* Slovensky komentar: Z formulara vycita hodnoty na ulozenie. */
  function readFormValues() {
    return {
      LIST_ONLY: form.LIST_ONLY.checked,
      DRY_RUN: form.DRY_RUN.checked,
      CAPTURE_ONLY_CANDIDATES: form.CAPTURE_ONLY_CANDIDATES.checked,
      CONFIRM_BEFORE_DELETE: form.CONFIRM_BEFORE_DELETE.checked,
      AUTO_SCAN: form.AUTO_SCAN.checked,
      MAX_MESSAGES: Number(form.MAX_MESSAGES.value),
      USER_MESSAGES_MAX: Number(form.USER_MESSAGES_MAX.value),
      SCAN_COOLDOWN_MIN: Number(form.SCAN_COOLDOWN_MIN.value),
      SAFE_URL_INPUT: form.SAFE_URL_PATTERNS.value || ''
    };
  }

  /* Slovensky komentar: Porovna dve konfiguracie a vrati diff. */
  function diffSettings(previous, next) {
    const diff = {};
    const keys = new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
    keys.forEach((key) => {
      const beforeValue = previous ? previous[key] : undefined;
      const afterValue = next ? next[key] : undefined;
      const equal = Array.isArray(beforeValue)
        ? Array.isArray(afterValue) && beforeValue.length === afterValue.length && beforeValue.every((value, index) => value === afterValue[index])
        : beforeValue === afterValue;
      if (!equal) {
        diff[key] = { old: beforeValue, new: afterValue };
      }
    });
    return diff;
  }

  /* Slovensky komentar: Bezpecne zaloguje chybu. */
  async function logError(message, meta) {
    try {
      await Logger.log('error', 'settings', message, meta);
    } catch (_logError) {
      /* Slovensky komentar: Ignoruje chybu pri logovani. */
    }
  }

  /* Slovensky komentar: Bezpecne zaloguje info diff. */
  async function logInfo(message, meta) {
    try {
      await Logger.log('info', 'settings', message, meta);
    } catch (_logError) {
      /* Slovensky komentar: Ignoruje chybu pri logovani. */
    }
  }

  /* Slovensky komentar: Nacita nastavenia, aplikuje normalizaciu a zobrazi formular. */
  async function loadSettings() {
    try {
      const defaults = defaultsFactory();
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      const raw = stored && typeof stored[SETTINGS_KEY] === 'object' ? stored[SETTINGS_KEY] : null;
      const { settings: sanitized, healedFields } = sanitizeFn(raw || defaults);
      const normalization = normalizeFn(sanitized.SAFE_URL_PATTERNS);
      const nextSettings = {
        ...sanitized,
        SAFE_URL_PATTERNS: normalization.patterns
      };
      const needsPersist = !raw || (Array.isArray(healedFields) && healedFields.length > 0) || normalization.fixed;
      if (needsPersist) {
        await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
      }
      currentSettings = nextSettings;
      populateForm(nextSettings);
      const healed = new Set(Array.isArray(healedFields) ? healedFields : []);
      if (normalization.fixed) {
        healed.add('SAFE_URL_PATTERNS');
      }
      renderHealedHints(Array.from(healed));
      setStatus(healed.size ? 'Niektoré položky boli automaticky opravené.' : '');
      return nextSettings;
    } catch (error) {
      const defaults = defaultsFactory();
      currentSettings = defaults;
      populateForm(defaults);
      renderHealedHints([]);
      const message = error && error.message ? error.message : String(error);
      showToast(`Načítanie zlyhalo: ${message}`);
      setStatus('Nepodarilo sa načítať nastavenia.');
      console.error('Settings load failed', error);
      await logError('Settings load failed', {
        scope: 'settings',
        reasonCode: 'settings_load_failed',
        message
      });
      return defaults;
    }
  }

  /* Slovensky komentar: Ulozi nastavenia do storage a zaloguje diff. */
  async function saveSettings() {
    try {
      const previous = currentSettings;
      const formValues = readFormValues();
      const normalization = normalizeFn(formValues.SAFE_URL_INPUT);
      const nextSettings = {
        ...previous,
        LIST_ONLY: formValues.LIST_ONLY,
        DRY_RUN: formValues.DRY_RUN,
        CAPTURE_ONLY_CANDIDATES: formValues.CAPTURE_ONLY_CANDIDATES,
        CONFIRM_BEFORE_DELETE: formValues.CONFIRM_BEFORE_DELETE,
        AUTO_SCAN: formValues.AUTO_SCAN,
        MAX_MESSAGES: Number.isFinite(formValues.MAX_MESSAGES) ? formValues.MAX_MESSAGES : previous.MAX_MESSAGES,
        USER_MESSAGES_MAX: Number.isFinite(formValues.USER_MESSAGES_MAX) ? formValues.USER_MESSAGES_MAX : previous.USER_MESSAGES_MAX,
        SCAN_COOLDOWN_MIN: Number.isFinite(formValues.SCAN_COOLDOWN_MIN) ? formValues.SCAN_COOLDOWN_MIN : previous.SCAN_COOLDOWN_MIN,
        SAFE_URL_PATTERNS: normalization.patterns
      };
      await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
      currentSettings = nextSettings;
      populateForm(nextSettings);
      const healed = normalization.fixed ? ['SAFE_URL_PATTERNS'] : [];
      renderHealedHints(healed);
      const changes = diffSettings(previous, nextSettings);
      await logInfo('Settings saved', {
        scope: 'settings',
        diff: changes,
        before: previous,
        after: nextSettings
      });
      showToast('Uložené');
      const hasChanges = Object.keys(changes).length > 0;
      if (!hasChanges && !normalization.fixed) {
        setStatus('Žiadne zmeny na uloženie.');
      } else if (normalization.fixed) {
        setStatus('Nastavenia uložené. Niektoré URL boli opravené.');
      } else {
        setStatus('Nastavenia uložené.');
      }
      return nextSettings;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      showToast(`Uloženie zlyhalo: ${message}`);
      setStatus('Uloženie zlyhalo.');
      console.error('Settings save failed', error);
      await logError('Settings save failed', {
        scope: 'settings',
        reasonCode: 'settings_save_failed',
        message
      });
      return currentSettings;
    }
  }

  /* Slovensky komentar: Obnovi predvolene nastavenia a znova nacita formular. */
  async function resetToDefaults() {
    const previous = currentSettings;
    try {
      const defaults = defaultsFactory();
      await chrome.storage.local.set({ [SETTINGS_KEY]: defaults });
      const nextSettings = await loadSettings();
      showToast('Nastavenia obnovené na defaulty');
      setStatus('Predvolené hodnoty boli obnovené.');
      const changes = diffSettings(previous, nextSettings);
      await logInfo('Settings reset to defaults', {
        scope: 'settings',
        diff: changes,
        before: previous,
        after: nextSettings
      });
      return nextSettings;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      showToast(`Reset zlyhal: ${message}`);
      setStatus('Reset zlyhal.');
      console.error('Settings reset failed', error);
      await logError('Settings reset failed', {
        scope: 'settings',
        reasonCode: 'settings_reset_failed',
        message
      });
      return currentSettings;
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveSettings();
  });

  document.getElementById('reset-btn').addEventListener('click', async () => {
    await resetToDefaults();
  });

  await loadSettings();
})();

