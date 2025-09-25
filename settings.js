import { initDb, categories } from './db.js';
import { csvToArray, arrayToCsv, logInfo } from './utils.js';

const DEFAULT_SETTINGS = {
  LIST_ONLY: true,
  ALLOW_LOCAL_BACKUP_WHEN_LIST_ONLY: false,
  DRY_RUN: true,
  CONFIRM_BEFORE_DELETE: true,
  AUTO_SCAN: true,
  COOLDOWN_MIN: 5,
  MAX_MESSAGES: 2,
  USER_MESSAGES_MAX: 2,
  MIN_AGE_MINUTES: 2,
  DELETE_LIMIT: 10,
  SAFE_URL_PATTERNS: ['/workspaces', '/projects', '/new-project','/codex'],
  REPORT_LIMIT: 200,
  INCLUDE_BACKUP_SNAPSHOT_ID: true,
  DEBUG_LEVEL: 'INFO',
  TRACE_EXTRACTOR: false,
  TRACE_RUNNER: false,
  REDACT_TEXT_IN_DIAGNOSTICS: true,
  DIAGNOSTICS_SAFE_SNAPSHOT: false,
  LIVE_MODE_ENABLED: false,
  LIVE_WHITELIST_HOSTS: ['chatgpt.com'],
  LIVE_PATCH_BATCH_LIMIT: 5,
  LIVE_PATCH_RATE_LIMIT_PER_MIN: 10,
  LIVE_REQUIRE_EXPLICIT_CONFIRM: true,
  AUDIT_LOG_LIMIT: 1000,
  UNDO_BATCH_LIMIT: 5,
  SHOW_UNDO_TOOLS: true
};

const FIELD_DEFS = [
  { key: 'LIST_ONLY', label: 'LIST_ONLY', type: 'checkbox', group: 'safety' },
  {
    key: 'ALLOW_LOCAL_BACKUP_WHEN_LIST_ONLY',
    label: 'ALLOW_LOCAL_BACKUP_WHEN_LIST_ONLY',
    type: 'checkbox',
    group: 'safety'
  },
  { key: 'DRY_RUN', label: 'DRY_RUN', type: 'checkbox', group: 'safety' },
  { key: 'CONFIRM_BEFORE_DELETE', label: 'CONFIRM_BEFORE_DELETE', type: 'checkbox', group: 'safety' },
  { key: 'LIVE_MODE_ENABLED', label: 'LIVE_MODE_ENABLED', type: 'checkbox', group: 'safety' },
  {
    key: 'LIVE_REQUIRE_EXPLICIT_CONFIRM',
    label: 'LIVE_REQUIRE_EXPLICIT_CONFIRM',
    type: 'checkbox',
    group: 'safety'
  },
  { key: 'LIVE_PATCH_BATCH_LIMIT', label: 'LIVE_PATCH_BATCH_LIMIT', type: 'number', min: 1, group: 'safety' },
  {
    key: 'LIVE_PATCH_RATE_LIMIT_PER_MIN',
    label: 'LIVE_PATCH_RATE_LIMIT_PER_MIN',
    type: 'number',
    min: 0,
    group: 'safety'
  },
  { key: 'UNDO_BATCH_LIMIT', label: 'UNDO_BATCH_LIMIT', type: 'number', min: 1, group: 'safety' },
  { key: 'LIVE_WHITELIST_HOSTS', label: 'LIVE_WHITELIST_HOSTS', type: 'textarea', group: 'safety' },
  { key: 'SHOW_UNDO_TOOLS', label: 'SHOW_UNDO_TOOLS', type: 'checkbox', group: 'safety' },
  { key: 'AUTO_SCAN', label: 'AUTO_SCAN', type: 'checkbox', group: 'automation' },
  { key: 'COOLDOWN_MIN', label: 'COOLDOWN_MIN', type: 'number', min: 0, group: 'automation' },
  { key: 'MAX_MESSAGES', label: 'MAX_MESSAGES', type: 'number', min: 1, group: 'heuristics' },
  { key: 'USER_MESSAGES_MAX', label: 'USER_MESSAGES_MAX', type: 'number', min: 1, group: 'heuristics' },
  { key: 'MIN_AGE_MINUTES', label: 'MIN_AGE_MINUTES', type: 'number', min: 0, group: 'heuristics' },
  { key: 'DELETE_LIMIT', label: 'DELETE_LIMIT', type: 'number', min: 1, group: 'heuristics' },
  { key: 'SAFE_URL_PATTERNS', label: 'SAFE_URL_PATTERNS', type: 'textarea', group: 'heuristics' },
  { key: 'REPORT_LIMIT', label: 'REPORT_LIMIT', type: 'number', min: 1, group: 'diagnostics' },
  {
    key: 'INCLUDE_BACKUP_SNAPSHOT_ID',
    label: 'INCLUDE_BACKUP_SNAPSHOT_ID',
    type: 'checkbox',
    group: 'diagnostics'
  },
  {
    key: 'DEBUG_LEVEL',
    label: 'DEBUG_LEVEL',
    type: 'select',
    options: ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'],
    group: 'diagnostics'
  },
  { key: 'TRACE_EXTRACTOR', label: 'TRACE_EXTRACTOR', type: 'checkbox', group: 'diagnostics' },
  { key: 'TRACE_RUNNER', label: 'TRACE_RUNNER', type: 'checkbox', group: 'diagnostics' },
  {
    key: 'REDACT_TEXT_IN_DIAGNOSTICS',
    label: 'REDACT_TEXT_IN_DIAGNOSTICS',
    type: 'checkbox',
    group: 'diagnostics'
  },
  {
    key: 'DIAGNOSTICS_SAFE_SNAPSHOT',
    label: 'DIAGNOSTICS_SAFE_SNAPSHOT',
    type: 'checkbox',
    group: 'diagnostics'
  }
];

function toDisplayValue(key, value) {
  if (key === 'SAFE_URL_PATTERNS' || key === 'LIVE_WHITELIST_HOSTS') {
    if (Array.isArray(value)) {
      return arrayToCsv(value);
    }
    return arrayToCsv(csvToArray(value || ''));
  }
  return value;
}

function normalizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  if (!Array.isArray(merged.SAFE_URL_PATTERNS)) {
    merged.SAFE_URL_PATTERNS = csvToArray(merged.SAFE_URL_PATTERNS || '');
  }
  if (!Array.isArray(merged.LIVE_WHITELIST_HOSTS)) {
    merged.LIVE_WHITELIST_HOSTS = csvToArray(merged.LIVE_WHITELIST_HOSTS || '');
  }
  const parsedLimit = Number.parseInt(merged.REPORT_LIMIT, 10);
  merged.REPORT_LIMIT = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.floor(parsedLimit))
    : DEFAULT_SETTINGS.REPORT_LIMIT;
  const parsedBatch = Number.parseInt(merged.LIVE_PATCH_BATCH_LIMIT, 10);
  merged.LIVE_PATCH_BATCH_LIMIT = Number.isFinite(parsedBatch)
    ? Math.max(1, Math.floor(parsedBatch))
    : DEFAULT_SETTINGS.LIVE_PATCH_BATCH_LIMIT;
  const parsedRate = Number.parseInt(merged.LIVE_PATCH_RATE_LIMIT_PER_MIN, 10);
  merged.LIVE_PATCH_RATE_LIMIT_PER_MIN = Number.isFinite(parsedRate)
    ? Math.max(0, Math.floor(parsedRate))
    : DEFAULT_SETTINGS.LIVE_PATCH_RATE_LIMIT_PER_MIN;
  const parsedAudit = Number.parseInt(merged.AUDIT_LOG_LIMIT, 10);
  merged.AUDIT_LOG_LIMIT = Number.isFinite(parsedAudit)
    ? Math.max(1, Math.floor(parsedAudit))
    : DEFAULT_SETTINGS.AUDIT_LOG_LIMIT;
  const parsedUndo = Number.parseInt(merged.UNDO_BATCH_LIMIT, 10);
  merged.UNDO_BATCH_LIMIT = Number.isFinite(parsedUndo)
    ? Math.max(1, Math.floor(parsedUndo))
    : DEFAULT_SETTINGS.UNDO_BATCH_LIMIT;
  merged.LIVE_MODE_ENABLED = Boolean(merged.LIVE_MODE_ENABLED);
  merged.LIVE_REQUIRE_EXPLICIT_CONFIRM = merged.LIVE_REQUIRE_EXPLICIT_CONFIRM !== false;
  merged.SHOW_UNDO_TOOLS = merged.SHOW_UNDO_TOOLS !== false;
  merged.INCLUDE_BACKUP_SNAPSHOT_ID = Boolean(merged.INCLUDE_BACKUP_SNAPSHOT_ID);
  return merged;
}

export async function init({ root }) {
  await initDb();

  const groups = {
    safety: root.querySelector('[data-group="safety"]'),
    heuristics: root.querySelector('[data-group="heuristics"]'),
    automation: root.querySelector('[data-group="automation"]'),
    diagnostics: root.querySelector('[data-group="diagnostics"]')
  };
  const categoryList = root.querySelector('[data-role="category-list"]');
  const categoryForm = root.querySelector('[data-role="category-form"]');

  let settings = await loadSettings();
  let catalog = await categories.list();

  FIELD_DEFS.forEach((field) => {
    const container = document.createElement('div');
    container.className = 'setting-field';

    const label = document.createElement('label');
    label.textContent = field.label;

    let input;
    if (field.type === 'textarea') {
      input = document.createElement('textarea');
    } else if (field.type === 'select') {
      input = document.createElement('select');
      (field.options || []).forEach((option) => {
        const opt = document.createElement('option');
        opt.value = option;
        opt.textContent = option;
        input.appendChild(opt);
      });
    } else {
      input = document.createElement('input');
      input.type = field.type;
      if (field.type === 'number' && field.min !== undefined) {
        input.min = String(field.min);
      }
      if (field.type === 'checkbox') {
        input.checked = Boolean(settings[field.key]);
      }
    }

    if (field.type !== 'checkbox') {
      const displayValue = toDisplayValue(field.key, settings[field.key]);
      input.value = displayValue !== undefined && displayValue !== null ? String(displayValue) : '';
    }

    input.dataset.settingKey = field.key;

    container.appendChild(label);
    container.appendChild(input);

    groups[field.group].appendChild(container);
  });

  /**
   * Slovensky: Spracuje zmeny polí a uloží ich do storage.
   */
  root.addEventListener('change', async (event) => {
    const target = event.target;
    if (
      !(
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
    ) {
      return;
    }
    const key = target.dataset.settingKey;
    if (!key) {
      return;
    }

    let value;
    if (target.type === 'checkbox') {
      value = target.checked;
    } else if (target.type === 'number') {
      value = Number.parseInt(target.value, 10) || 0;
    } else {
      value = target.value;
    }
    if (key === 'SAFE_URL_PATTERNS' || key === 'LIVE_WHITELIST_HOSTS') {
      const arr = csvToArray(value);
      target.value = arrayToCsv(arr);
      value = arr;
    }

    settings = normalizeSettings({ ...settings, [key]: value });
    await chrome.storage.local.set({ settings });
    await logInfo('ui', 'Setting updated', { key, value });
  });

  categoryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(categoryForm);
    const name = (data.get('category') || '').toString().trim();
    if (!name) {
      return;
    }
    try {
      await categories.add(name);
      catalog = await categories.list();
      categoryForm.reset();
      renderCategories();
      await logInfo('ui', 'Category added', { name });
    } catch (error) {
      console.warn(error);
    }
  });

  categoryList.addEventListener('click', async (event) => {
    const removeBtn = event.target.closest('button[data-action="delete-category"]');
    const renameBtn = event.target.closest('button[data-action="rename-category"]');
    if (removeBtn) {
      const id = removeBtn.dataset.id;
      await categories.delete(id);
      catalog = catalog.filter((item) => item.id !== id);
      renderCategories();
      window.dispatchEvent(new Event('mychatgpt-backups-changed'));
      await logInfo('ui', 'Category deleted', { id });
    } else if (renameBtn) {
      const id = renameBtn.dataset.id;
      const current = catalog.find((item) => item.id === id);
      const nextName = prompt('Rename category', current?.name || '');
      if (!nextName || !nextName.trim()) {
        return;
      }
      await categories.rename(id, nextName.trim());
      catalog = await categories.list();
      renderCategories();
      window.dispatchEvent(new Event('mychatgpt-backups-changed'));
      await logInfo('ui', 'Category renamed', { id, name: nextName.trim() });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) {
      return;
    }
    settings = normalizeSettings(changes.settings.newValue);
    syncInputs();
  });

  renderCategories();
  syncInputs();

  return {
    onShow: async () => {
      settings = await loadSettings();
      catalog = await categories.list();
      syncInputs();
      renderCategories();
    }
  };

  function syncInputs() {
    FIELD_DEFS.forEach((field) => {
      const input = root.querySelector(`[data-setting-key="${field.key}"]`);
      if (!input) {
        return;
      }
      if (field.type === 'checkbox') {
        input.checked = Boolean(settings[field.key]);
      } else {
        const value = toDisplayValue(field.key, settings[field.key]);
        input.value = value !== undefined && value !== null ? String(value) : '';
      }
    });
  }

  function renderCategories() {
    categoryList.innerHTML = '';
    catalog
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((item) => {
        const li = document.createElement('li');
        li.className = 'flex-between';
        const span = document.createElement('span');
        span.textContent = item.name;
        const actions = document.createElement('div');
        const rename = document.createElement('button');
        rename.className = 'secondary';
        rename.dataset.action = 'rename-category';
        rename.dataset.id = item.id;
        rename.textContent = 'Rename';
        rename.type = 'button';
        const del = document.createElement('button');
        del.className = 'secondary';
        del.dataset.action = 'delete-category';
        del.dataset.id = item.id;
        del.textContent = 'Delete';
        del.type = 'button';
        actions.appendChild(rename);
        actions.appendChild(del);
        li.appendChild(span);
        li.appendChild(actions);
        categoryList.appendChild(li);
      });
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(['settings']);
  return normalizeSettings(stored.settings);
}
