/* Slovensky komentar: Stranka nastaveni nacita, validuje a uklada konfiguraciu. */
(async function () {
  const form = document.getElementById('settings-form');
  const statusText = document.getElementById('status-text');
  const healHints = new Map();
  document.querySelectorAll('.heal-hint').forEach((element) => {
    healHints.set(element.dataset.field, element);
  });

  let currentSettings = SettingsStore.defaults();

  /* Slovensky komentar: Aktualizuje zobrazenie hintov pre opravene polia. */
  function renderHealedHints(healedFields) {
    healHints.forEach((element) => {
      element.hidden = true;
    });
    healedFields.forEach((field) => {
      const element = healHints.get(field);
      if (element) {
        element.hidden = false;
      }
    });
  }

  /* Slovensky komentar: Vyplni formular na zaklade nastaveni. */
  function populateForm(settings) {
    form.LIST_ONLY.checked = Boolean(settings.LIST_ONLY);
    form.DRY_RUN.checked = Boolean(settings.DRY_RUN);
    form.CAPTURE_ONLY_CANDIDATES.checked = Boolean(settings.CAPTURE_ONLY_CANDIDATES);
    form.CONFIRM_BEFORE_DELETE.checked = Boolean(settings.CONFIRM_BEFORE_DELETE);
    form.AUTO_SCAN.checked = Boolean(settings.AUTO_SCAN);
    form.MAX_MESSAGES.value = settings.MAX_MESSAGES;
    form.USER_MESSAGES_MAX.value = settings.USER_MESSAGES_MAX;
    form.SCAN_COOLDOWN_MIN.value = settings.SCAN_COOLDOWN_MIN;
    form.SAFE_URL_PATTERNS.value = settings.SAFE_URL_PATTERNS.join('\n');
  }

  /* Slovensky komentar: Z formulara vycita hodnoty pre ulozenie. */
  function readFormValues() {
    const patterns = form.SAFE_URL_PATTERNS.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length);
    return {
      LIST_ONLY: form.LIST_ONLY.checked,
      DRY_RUN: form.DRY_RUN.checked,
      CAPTURE_ONLY_CANDIDATES: form.CAPTURE_ONLY_CANDIDATES.checked,
      CONFIRM_BEFORE_DELETE: form.CONFIRM_BEFORE_DELETE.checked,
      AUTO_SCAN: form.AUTO_SCAN.checked,
      MAX_MESSAGES: Number(form.MAX_MESSAGES.value),
      USER_MESSAGES_MAX: Number(form.USER_MESSAGES_MAX.value),
      SCAN_COOLDOWN_MIN: Number(form.SCAN_COOLDOWN_MIN.value),
      SAFE_URL_PATTERNS: patterns
    };
  }

  /* Slovensky komentar: Porovna dve sady nastaveni a vrati zmenene polia. */
  function diffSettings(previous, next) {
    const diff = {};
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    keys.forEach((key) => {
      const beforeValue = previous[key];
      const afterValue = next[key];
      const areEqual = Array.isArray(beforeValue)
        ? Array.isArray(afterValue) && beforeValue.length === afterValue.length && beforeValue.every((value, index) => value === afterValue[index])
        : beforeValue === afterValue;
      if (!areEqual) {
        diff[key] = { before: beforeValue, after: afterValue };
      }
    });
    return diff;
  }

  /* Slovensky komentar: Nastavi text stavu pre pouzivatela. */
  function setStatus(message) {
    statusText.textContent = message;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const previous = currentSettings;
    const rawInput = readFormValues();
    const { settings: sanitized, healedFields } = await SettingsStore.save(rawInput);
    currentSettings = sanitized;
    renderHealedHints(healedFields);
    const changes = diffSettings(previous, sanitized);
    await Logger.log('info', 'settings', 'Settings updated', {
      changed: changes,
      before: previous,
      after: sanitized
    });
    if (Object.keys(changes).length === 0 && healedFields.length === 0) {
      setStatus('Žiadne zmeny na uloženie.');
    } else {
      setStatus('Nastavenia uložené.');
    }
  });

  document.getElementById('reset-btn').addEventListener('click', () => {
    const defaults = SettingsStore.defaults();
    populateForm(defaults);
    renderHealedHints([]);
    setStatus('Predvolené hodnoty boli obnovené v editore.');
  });

  try {
    const { settings, healedFields } = await SettingsStore.load();
    currentSettings = settings;
    populateForm(settings);
    renderHealedHints(healedFields);
    if (healedFields.length) {
      setStatus('Niektoré položky boli automaticky opravené.');
    }
  } catch (error) {
    await Logger.log('error', 'settings', 'Failed to load settings page', {
      message: error && error.message
    });
    setStatus('Nepodarilo sa načítať nastavenia.');
  }
})();

