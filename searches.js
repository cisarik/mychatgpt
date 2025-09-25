import { initDb, backups } from './db.js';
import { logInfo } from './utils.js';

export async function init({ root, switchTab, getSearchValue, toast }) {
  await initDb();

  const tbody = root.querySelector('[data-role="searches-rows"]');
  const emptyState = root.querySelector('[data-role="searches-empty"]');
  const badge = root.querySelector('.badge');
  const manualButton = root.querySelector('[data-action="manual-backup"]');
  const state = {
    rows: [],
    filter: getSearchValue()?.toLowerCase() || ''
  };

  /**
   * Slovensky: Načíta záznamy z IndexedDB a obnoví tabuľku.
   */
  async function refresh() {
    state.rows = await backups.get();
    applyFilter(state.filter);
  }

  function applyFilter(raw) {
    const term = (raw || '').toLowerCase();
    state.filter = term;
    const filtered = state.rows.filter((row) => {
      if (!term) return true;
      return (
        row.title?.toLowerCase().includes(term) ||
        row.questionText?.toLowerCase().includes(term) ||
        row.category?.toLowerCase().includes(term)
      );
    });
    renderRows(filtered);
  }

  function renderRows(rows) {
    tbody.innerHTML = '';
    if (!rows.length) {
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(row.title)}</td>
        <td>${escapeHtml(truncate(row.questionText, 80))}</td>
        <td>${escapeHtml(row.category || '')}</td>
        <td>${formatTimestamp(row.timestamp)}</td>
        <td><button class="secondary" data-action="open" data-id="${row.id}">Open</button></td>
      `;
      tbody.appendChild(tr);
    });
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value || '';
    return div.innerHTML;
  }

  function truncate(text, size) {
    const value = text || '';
    if (value.length <= size) {
      return value;
    }
    return `${value.slice(0, size - 1)}…`;
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

  tbody.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action="open"]');
    if (!button) {
      return;
    }
    const id = button.dataset.id;
    await logInfo('ui', 'Backup selected from table', { id });
    await chrome.storage.local.set({ ui_selected_backup_id: id });
    window.dispatchEvent(new CustomEvent('mychatgpt-backup-selected', { detail: { id } }));
    await switchTab('backup');
  });

  if (manualButton) {
    manualButton.addEventListener('click', async () => {
      manualButton.disabled = true;
      try {
        await logInfo('ui', 'Manual backup requested via popup');
        const response = await chrome.runtime.sendMessage({ type: 'manualBackup' });
        if (response?.stored) {
          const code = typeof response.id === 'string' ? response.id.slice(0, 8) : 'saved';
          toast?.(`Backup stored (${code})`, 'success');
          await refresh();
        } else if (response?.wouldStore) {
          toast?.('LIST_ONLY prevents storing. Toggle ALLOW_LOCAL_BACKUP_WHEN_LIST_ONLY.', 'warning');
        } else if (response?.qualified === false) {
          toast?.('Conversation did not meet short-chat qualifiers.', 'warning');
        } else if (response?.reason === 'meta-missing' || response?.reason === 'qa-missing') {
          toast?.('Could not read chat content. Try again after the page loads.', 'warning');
        } else if (response?.reason === 'cooldown') {
          toast?.('Runner cooldown active; try again in a moment.', 'info');
        } else if (response?.reason === 'safe-url') {
          toast?.('URL marked as safe. Update SAFE_URL_PATTERNS to allow backup.', 'info');
        } else if (response?.error === 'no-active-chat-tab') {
          toast?.('Open chatgpt.com tab to run manual backup.', 'error');
        } else {
          toast?.('Manual backup did not store any entry.', 'info');
        }
      } catch (error) {
        toast?.('Manual backup failed. See Debug logs.', 'error');
        console.error(error);
      } finally {
        manualButton.disabled = false;
      }
    });
  }

  window.addEventListener('mychatgpt-backups-changed', refresh);
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'mychatgpt-backups-changed') {
      refresh();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) {
      return;
    }
    syncBadge(changes.settings.newValue);
  });

  await refresh();
  await syncBadge();
  return {
    onShow: refresh,
    onSearch: applyFilter
  };

  async function syncBadge(overrides) {
    const data = overrides || (await chrome.storage.local.get(['settings'])).settings;
    const isListOnly = (data?.LIST_ONLY ?? true) === true;
    if (!badge) {
      return;
    }
    badge.textContent = isListOnly ? 'LIST ONLY' : 'PATCH READY';
  }
}
