import { initDb } from './db.js';
import { logInfo } from './utils.js';

const SOFT_PLAN_STORAGE_KEY = 'soft_delete_plan';

const tabConfig = {
  searches: {
    html: 'searches.html',
    loader: () => import('./searches.js')
  },
  backup: {
    html: 'backup.html',
    loader: () => import('./backup.js')
  },
  settings: {
    html: 'settings.html',
    loader: () => import('./settings.js')
  },
  debug: {
    html: 'debug.html',
    loader: () => import('./debug.js')
  }
};

const htmlTextCache = new Map();
const tabRootCache = new Map();
const handlersCache = new Map();

const searchInput = document.getElementById('global-search');
const tabContent = document.getElementById('tab-content');
const tabButtons = Array.from(document.querySelectorAll('.tab-button'));
const toastHost = createToastHost();
const badgeButton = document.getElementById('would-delete-badge');
const badgeCount = badgeButton?.querySelector('[data-role="badge-count"]');

let activeTab = null;

(async function bootstrapPopup() {
  await initDb();
  await logInfo('ui', 'Popup opened');
  bindNav();
  bindSearch();
  bindBadge();
  await syncBadge();
  await switchTab('searches');
})();

function bindNav() {
  tabButtons.forEach((button) => {
    button.addEventListener('click', async () => {
      const name = button.dataset.tab;
      await switchTab(name);
    });
  });
}

function bindSearch() {
  /**
   * Slovensky: Preposiela text vyhľadávania aktívnemu tabu.
   */
  const emit = () => {
    const value = searchInput.value.trim();
    const handler = handlersCache.get(activeTab);
    if (handler?.onSearch) {
      handler.onSearch(value);
    }
  };
  searchInput.addEventListener('input', emit);
}

async function switchTab(name) {
  if (!tabConfig[name]) {
    return;
  }
  if (activeTab === name) {
    const handler = handlersCache.get(name);
    handler?.onShow?.();
    return;
  }
  activeTab = name;
  updateButtonState(name);
  const tabRoot = await ensureTab(name);
  tabContent.innerHTML = '';
  tabContent.appendChild(tabRoot);
  const handler = handlersCache.get(name);
  handler?.onShow?.();
  const currentValue = searchInput.value.trim();
  if (currentValue && handler?.onSearch) {
    handler.onSearch(currentValue);
  }
}

function bindBadge() {
  if (!badgeButton) {
    return;
  }
  badgeButton.addEventListener('click', async () => {
    await switchTab('debug');
    const handler = handlersCache.get('debug');
    handler?.focusSoftDeletePlan?.();
  });
}

async function syncBadge() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'PLAN_GET' });
    if (response?.ok) {
      applyBadge(response.plan);
    }
  } catch (error) {
    console.error(error);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SOFT_PLAN_STORAGE_KEY]) {
      return;
    }
    applyBadge(changes[SOFT_PLAN_STORAGE_KEY].newValue);
  });
}

/**
 * Slovensky: Aktualizuje odznak s počtom plánovaných DRY-RUN zásahov.
 */
function applyBadge(plan) {
  if (!badgeButton || !badgeCount) {
    return;
  }
  const normalized = normalizePlan(plan);
  badgeCount.textContent = String(normalized.totals.planned);
  badgeButton.hidden = normalized.totals.planned === 0;
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== 'object') {
    return { totals: { planned: 0 } };
  }
  const total = Number.isFinite(plan?.totals?.planned)
    ? plan.totals.planned
    : Number.parseInt(plan.totals?.planned, 10);
  return {
    totals: { planned: Number.isFinite(total) ? total : 0 }
  };
}

function updateButtonState(active) {
  tabButtons.forEach((button) => {
    const selected = button.dataset.tab === active;
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

async function ensureTab(name) {
  if (tabRootCache.has(name)) {
    return tabRootCache.get(name);
  }

  const html = await loadHtml(tabConfig[name].html);
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  const tabRoot = wrapper.firstElementChild;

  const module = await tabConfig[name].loader();
  const handler = await module.init({
    root: tabRoot,
    switchTab,
    getSearchValue: () => searchInput.value.trim(),
    toast: showToast
  });
  handlersCache.set(name, handler || {});
  tabRootCache.set(name, tabRoot);
  return tabRoot;
}

async function loadHtml(path) {
  if (htmlTextCache.has(path)) {
    return htmlTextCache.get(path);
  }
  const response = await fetch(chrome.runtime.getURL(path));
  const text = await response.text();
  htmlTextCache.set(path, text);
  return text;
}

function createToastHost() {
  const host = document.createElement('div');
  host.id = 'toast-host';
  document.body.appendChild(host);
  return host;
}

/**
 * Slovensky: Zobrazí krátku toast hlášku v popupe.
 */
function showToast(message, variant = 'info') {
  if (!message) {
    return;
  }
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.dataset.variant = variant;
  toast.textContent = message;
  toastHost.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 200);
  }, 2600);
}
