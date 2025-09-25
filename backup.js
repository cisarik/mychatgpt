import { initDb, backups, categories } from './db.js';
import { sanitizeHTML, logInfo } from './utils.js';

export async function init({ root, toast }) {
  await initDb();

  const listRoot = root.querySelector('[data-role="backup-list"]');
  const emptyState = root.querySelector('[data-role="backup-empty"]');
  const refreshBtn = root.querySelector('[data-action="refresh-backups"]');
  const previewPanel = root.querySelector('[data-role="backup-preview"]');
  const previewTitle = root.querySelector('[data-field="preview-title"]');
  const previewMeta = root.querySelector('[data-field="preview-meta"]');
  const previewFrame = root.querySelector('[data-field="preview-frame"]');
  const closePreviewBtn = root.querySelector('[data-action="close-preview"]');
  const exportBtn = root.querySelector('[data-action="export-backup"]');
  const deleteBtn = root.querySelector('[data-action="delete-backup"]');

  let entries = [];
  let catalog = [];
  let selectedId = null;
  let settings = await loadSettings();

  /**
   * Slovensky: Znovu načíta zálohy aj kategórie zo storage.
   */
  async function refreshAll() {
    entries = await backups.get();
    catalog = await categories.list();
    renderList();
    syncSelection();
  }

  function renderList() {
    listRoot.innerHTML = '';
    if (!entries.length) {
      emptyState.hidden = false;
      previewPanel.hidden = true;
      return;
    }
    emptyState.hidden = true;
    entries.forEach((entry) => {
      listRoot.appendChild(renderRow(entry));
    });
  }

  function renderRow(entry) {
    const container = document.createElement('div');
    container.className = 'backup-item';
    container.dataset.id = entry.id;

    const main = document.createElement('div');
    main.className = 'backup-item-main';
    const titleEl = document.createElement('div');
    titleEl.className = 'backup-item-title';
    titleEl.textContent = entry.title || '(no title)';
    const metaEl = document.createElement('div');
    metaEl.className = 'backup-item-meta';
    const timestamp = formatTimestamp(entry.timestamp);
    metaEl.textContent = `${timestamp}${entry.category ? ` · ${entry.category}` : ''}`;
    main.appendChild(titleEl);
    main.appendChild(metaEl);

    const actions = document.createElement('div');
    actions.className = 'backup-item-actions';
    const select = document.createElement('select');
    select.dataset.action = 'category';
    buildCategoryOptions(select, entry.category);
    const preview = document.createElement('button');
    preview.className = 'secondary';
    preview.dataset.action = 'preview';
    preview.textContent = 'Preview';
    actions.appendChild(select);
    actions.appendChild(preview);

    container.appendChild(main);
    container.appendChild(actions);
    if (selectedId === entry.id) {
      container.classList.add('selected');
    }
    return container;
  }

  function buildCategoryOptions(select, current) {
    select.innerHTML = '';
    catalog.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.name;
      option.textContent = item.name;
      if (item.name === current) {
        option.selected = true;
      }
      select.appendChild(option);
    });
  }

  function syncSelection() {
    if (!selectedId) {
      previewPanel.hidden = true;
      return;
    }
    const entry = entries.find((item) => item.id === selectedId);
    if (!entry) {
      selectedId = null;
      previewPanel.hidden = true;
      return;
    }
    openPreview(entry);
  }

  function openPreview(entry) {
    selectedId = entry.id;
    listRoot.querySelectorAll('.backup-item').forEach((row) => {
      row.classList.toggle('selected', row.dataset.id === entry.id);
    });
    previewTitle.textContent = entry.title || '(no title)';
    previewMeta.textContent = buildPreviewMeta(entry);
    previewFrame.setAttribute('sandbox', '');
    previewFrame.srcdoc = buildPreviewHtml(entry.answerHTML);
    previewPanel.hidden = false;
  }

  function buildPreviewMeta(entry) {
    const timestamp = formatTimestamp(entry.timestamp);
    const pieces = [timestamp];
    if (entry.category) {
      pieces.push(entry.category);
    }
    if (entry.convoId) {
      pieces.push(`ID:${entry.convoId}`);
    }
    return pieces.join(' · ');
  }

  function buildPreviewHtml(html) {
    const safe = sanitizeHTML(html);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;padding:18px;font:15px/1.6 system-ui;background:#f8fafc;color:#0f172a;} .answer{border:1px solid rgba(148, 163, 184, 0.4);border-radius:12px;padding:16px;background:#fff;overflow:auto;} a{color:#1d4ed8;} pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;overflow:auto;} code{background:rgba(15,23,42,.08);padding:2px 4px;border-radius:4px;}</style></head><body><article class="answer">${safe}</article></body></html>`;
  }

  function formatTimestamp(ts) {
    if (!ts) {
      return '—';
    }
    try {
      return new Date(ts).toLocaleString();
    } catch (error) {
      return String(ts);
    }
  }

  async function updateCategory(id, next) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) {
      return;
    }
    const updated = { ...entry, category: next };
    await backups.add(updated);
    entry.category = next;
    await logInfo('ui', 'Backup category updated', { id, category: next });
    if (selectedId === id) {
      previewMeta.textContent = buildPreviewMeta(updated);
      previewFrame.srcdoc = buildPreviewHtml(updated.answerHTML);
    }
    window.dispatchEvent(new Event('mychatgpt-backups-changed'));
    chrome.runtime.sendMessage({ type: 'mychatgpt-backups-changed' }).catch(() => {
      // Slovensky: Žiadny poslucháč mimo popupu, takže chybu ignorujeme.
    });
  }

  async function deleteBackup(id) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) {
      return;
    }
    const requireConfirm = settings?.CONFIRM_BEFORE_DELETE !== false;
    if (requireConfirm) {
      const confirmed = window.confirm('Delete local backup?');
      if (!confirmed) {
        return;
      }
    }
    await backups.delete(id);
    entries = entries.filter((item) => item.id !== id);
    selectedId = selectedId === id ? null : selectedId;
    await logInfo('ui', 'Backup deleted', { id });
    toast?.('Backup deleted', 'info');
    renderList();
    syncSelection();
    window.dispatchEvent(new Event('mychatgpt-backups-changed'));
    chrome.runtime.sendMessage({ type: 'mychatgpt-backups-changed' }).catch(() => {
      // Slovensky: Popup môže byť jediný poslucháč, ignorujeme chybu.
    });
  }

  function exportBackup(entry) {
    const safeHtml = sanitizeHTML(entry.answerHTML);
    const html = buildExportHtml(entry, safeHtml);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const safeTitle = (entry.title || 'backup').replace(/[^a-z0-9-]+/gi, '-');
    const ts = new Date(entry.timestamp || Date.now()).toISOString().replace(/[:.]/g, '-');
    anchor.href = url;
    anchor.download = `${safeTitle}-${ts}.html`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast?.('Export downloaded', 'success');
  }

  listRoot.addEventListener('change', async (event) => {
    const select = event.target.closest('select[data-action="category"]');
    if (!select) {
      return;
    }
    const row = select.closest('.backup-item');
    const id = row?.dataset?.id;
    if (!id) {
      return;
    }
    await updateCategory(id, select.value);
    renderList();
  });

  listRoot.addEventListener('click', (event) => {
    const row = event.target.closest('.backup-item');
    if (!row) {
      return;
    }
    const id = row.dataset.id;
    if (!id) {
      return;
    }
    if (event.target.closest('button[data-action="preview"]')) {
      const entry = entries.find((item) => item.id === id);
      if (entry) {
        openPreview(entry);
      }
    }
  });

  refreshBtn?.addEventListener('click', refreshAll);
  closePreviewBtn?.addEventListener('click', () => {
    selectedId = null;
    previewPanel.hidden = true;
    listRoot.querySelectorAll('.backup-item').forEach((row) => row.classList.remove('selected'));
  });

  exportBtn?.addEventListener('click', () => {
    const entry = entries.find((item) => item.id === selectedId);
    if (entry) {
      exportBackup(entry);
    }
  });

  deleteBtn?.addEventListener('click', () => {
    if (selectedId) {
      deleteBackup(selectedId);
    }
  });

  window.addEventListener('mychatgpt-backups-changed', refreshAll);
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'mychatgpt-backups-changed') {
      refreshAll();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = { ...settings, ...(changes.settings.newValue || {}) };
    }
  });

  await refreshAll();

  return {
    onShow: refreshAll
  };
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(['settings']);
  return stored.settings || {};
}

function buildExportHtml(entry, safeHtml) {
  const timestamp = new Date(entry.timestamp || Date.now()).toISOString();
  const escapedTitle = escapeHtml(entry.title || 'Backup');
  const escapedQuestion = escapeHtml(entry.questionText || '');
  const escapedCategory = escapeHtml(entry.category || '');
  const escapedConvo = escapeHtml(entry.convoId || '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapedTitle} – ${timestamp}</title><style>body{max-width:880px;margin:2rem auto;font:16px/1.6 system-ui;background:#f8fafc;color:#0f172a;} header{margin-bottom:1.5rem;} .meta{font-size:.875rem;color:#475569;margin:0.25rem 0;} .answer{border:1px solid #cbd5f5;padding:1rem;border-radius:12px;background:#fff;} footer{margin-top:2rem;font-size:.85rem;color:#475569;}</style></head><body><header><h1>${escapedTitle}</h1><p class="meta">Saved: ${timestamp}</p><p class="meta">Category: ${escapedCategory || 'n/a'} · Conversation: ${escapedConvo || 'n/a'}</p></header><section><h2>Question</h2><p>${escapedQuestion}</p><h2>Answer</h2><article class="answer">${safeHtml}</article></section><footer><small>Exported from MyChatGPT</small></footer></body></html>`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value || '';
  return div.innerHTML;
}
