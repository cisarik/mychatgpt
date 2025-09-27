/* Slovensky komentar: Minimalisticke zobrazenie a mazanie zaloz. */
(async function () {
  const globalTarget = typeof window !== 'undefined' ? window : self;
  const listHost = document.getElementById('backups-list');
  const toastHost = document.getElementById('searches-toast');
  const bulkButton = document.getElementById('bulk-open-tabs-btn');

  if (!listHost) {
    return;
  }

  const defaultSettings = typeof cloneDefaultSettings === 'function'
    ? cloneDefaultSettings()
    : {
        LIST_ONLY: true,
        CONFIRM_BEFORE_DELETE: true
      };

  let settingsSnapshot = { ...defaultSettings };
  let isBulkRunning = false;

  /* Slovensky komentar: Kratke toast upozornenie. */
  function showToast(message) {
    if (!toastHost || !message) {
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
    }, 4000);
  }

  /* Slovensky komentar: Prelozi chybovy kod mazania na text. */
  function resolveDeleteReason(reason) {
    switch (reason) {
      case 'list_only':
        return 'Mazanie je zakázané nastavením „List only“.';
      case 'need_confirm':
        return 'Mazanie vyžaduje potvrdenie.';
      default:
        return 'Mazanie zlyhalo.';
    }
  }

  /* Slovensky komentar: Nastavi vizualne spustenie mazania na riadku. */
  function setRowLoading(rowEl, loading) {
    if (!rowEl) {
      return;
    }
    rowEl.classList.toggle('is-loading', Boolean(loading));
    const deleteButton = rowEl.querySelector('.row-del');
    if (deleteButton) {
      deleteButton.disabled = Boolean(loading);
      deleteButton.setAttribute('aria-busy', loading ? 'true' : 'false');
    }
  }

  /* Slovensky komentar: Ziska cerstve nastavenia zo storage. */
  async function refreshSettings() {
    try {
      const stored = await chrome.storage.local.get({ [SETTINGS_STORAGE_KEY]: null });
      const raw = stored ? stored[SETTINGS_STORAGE_KEY] : null;
      if (typeof sanitizeSettings === 'function') {
        const { settings } = sanitizeSettings(raw);
        settingsSnapshot = { ...defaultSettings, ...settings };
      } else if (raw && typeof raw === 'object') {
        settingsSnapshot = {
          ...defaultSettings,
          LIST_ONLY: typeof raw.LIST_ONLY === 'boolean' ? raw.LIST_ONLY : defaultSettings.LIST_ONLY,
          CONFIRM_BEFORE_DELETE:
            typeof raw.CONFIRM_BEFORE_DELETE === 'boolean'
              ? raw.CONFIRM_BEFORE_DELETE
              : defaultSettings.CONFIRM_BEFORE_DELETE
        };
      } else {
        settingsSnapshot = { ...defaultSettings };
      }
    } catch (_error) {
      settingsSnapshot = { ...defaultSettings };
    }
  }

  /* Slovensky komentar: Promise wrapper pre sendMessage. */
  function sendMessage(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message || 'Message failed'));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /* Slovensky komentar: Naformatuje casovy udaj na lokalny text. */
  function formatTimestamp(value) {
    if (typeof formatDate === 'function') {
      return formatDate(value);
    }
    try {
      return new Date(value).toLocaleString();
    } catch (_error) {
      return 'Neznámy čas';
    }
  }

  /* Slovensky komentar: Spracuje klik na mazanie. */
  async function handleDelete(backup, rowEl) {
    if (!backup || !backup.id) {
      return;
    }
    await refreshSettings();
    if (settingsSnapshot.LIST_ONLY) {
      showToast(resolveDeleteReason('list_only'));
      return;
    }
    if (settingsSnapshot.CONFIRM_BEFORE_DELETE) {
      const confirmed = globalTarget.confirm('Naozaj vymazať zálohu?');
      if (!confirmed) {
        return;
      }
    }

    setRowLoading(rowEl, true);
    try {
      const response = await sendMessage({ type: 'delete_backup', id: backup.id, confirm: true });
      if (!response || response.ok !== true) {
        const reason = response && response.reason ? response.reason : 'error';
        showToast(resolveDeleteReason(reason));
        return;
      }
      await loadAndRenderRecent();
    } catch (_error) {
      showToast(resolveDeleteReason('error'));
    } finally {
      setRowLoading(rowEl, false);
    }
  }

  /* Slovensky komentar: Vytvori riadok zo zaznamu zalohy. */
  function renderRow(backup) {
    const row = document.createElement('li');
    row.className = 'row';
    row.dataset.backupId = backup.id || '';

    const title = document.createElement('a');
    title.className = 'row-title';
    const rawTitle = backup && typeof backup.questionText === 'string' ? backup.questionText.trim() : '';
    title.textContent = rawTitle || '(untitled)';
    title.title = rawTitle || '(untitled)';
    if (backup && backup.id) {
      title.href = chrome.runtime.getURL(`pages/backup_view.html?id=${backup.id}`);
      title.target = '_blank';
      title.rel = 'noopener';
    } else {
      title.href = '#';
    }

    const delButton = document.createElement('button');
    delButton.type = 'button';
    delButton.className = 'row-del';
    delButton.title = 'Delete backup';
    delButton.setAttribute('aria-label', 'Delete backup');
    delButton.textContent = '×';
    delButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      handleDelete(backup, row).catch(() => {
        // Slovensky komentar: Chyba je uz osetrena toastom.
      });
    });

    const meta = document.createElement('div');
    meta.className = 'row-meta';

    const timeEl = document.createElement('time');
    timeEl.className = 'row-time';
    const timestamp = backup && Number.isFinite(backup.timestamp) ? backup.timestamp : null;
    if (timestamp) {
      try {
        timeEl.dateTime = new Date(timestamp).toISOString();
      } catch (_error) {
        // Slovensky komentar: ISO format nemusí byť dostupný pri zlom vstupe.
      }
    }
    timeEl.textContent = formatTimestamp(timestamp);
    meta.appendChild(timeEl);

    if (backup && backup.answerTruncated) {
      const badge = document.createElement('span');
      badge.className = 'row-badge';
      badge.textContent = '(truncated)';
      meta.appendChild(badge);
    }

    row.appendChild(title);
    row.appendChild(delButton);
    row.appendChild(meta);

    return row;
  }

  /* Slovensky komentar: Zobrazi najnovsie zaznamy. */
  function renderBackups(backups) {
    listHost.innerHTML = '';
    if (!Array.isArray(backups) || backups.length === 0) {
      return;
    }
    backups.forEach((backup) => {
      const row = renderRow(backup);
      listHost.appendChild(row);
    });
  }

  /* Slovensky komentar: Nacita najnovsie zaznamy z IndexedDB. */
  async function loadAndRenderRecent() {
    try {
      const items = await Database.getRecentBackups(20);
      renderBackups(items);
    } catch (error) {
      await Logger.log('error', 'db', 'Failed to load recent backups on searches page', {
        message: error && error.message
      });
      listHost.innerHTML = '';
    }
  }

  /* Slovensky komentar: Obsluha kliknutia na bulk backup. */
  async function handleBulkBackupClick() {
    if (!bulkButton) {
      return;
    }
    if (isBulkRunning) {
      return;
    }
    isBulkRunning = true;
    bulkButton.disabled = true;
    try {
      const response = await sendMessage({ type: 'bulk_backup_open_tabs' });
      if (!response || response.ok !== true) {
        const msg = response && response.error ? response.error : 'Bulk backup zlyhal.';
        showToast(msg);
      } else {
        showToast('Bulk backup spustený.');
      }
    } catch (error) {
      showToast((error && error.message) || 'Bulk backup zlyhal.');
    } finally {
      isBulkRunning = false;
      bulkButton.disabled = false;
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'backups_updated') {
      loadAndRenderRecent().catch(async (error) => {
        await Logger.log('warn', 'db', 'Backups reload failed after broadcast', {
          message: error && error.message
        });
      });
    }
    if (message && message.type === 'bulk_backup_summary') {
      showToast('Bulk backup dokončený.');
      loadAndRenderRecent().catch(async (error) => {
        await Logger.log('warn', 'db', 'Backups reload failed after summary', {
          message: error && error.message
        });
      });
    }
  });

  if (bulkButton) {
    bulkButton.addEventListener('click', () => {
      handleBulkBackupClick().catch(() => {
        // Slovensky komentar: Chyba je signalizovana toastom.
      });
    });
  }

  await refreshSettings();
  await loadAndRenderRecent();

  if (globalTarget && typeof globalTarget === 'object') {
    const api = globalTarget.SearchesPage || {};
    globalTarget.SearchesPage = {
      ...api,
      loadAndRenderRecent
    };
  }
})();
