/* Slovensky komentar: Stranka so zalohami zobrazi prazdny stav a pocet zaznamov. */
(async function () {
  const backupsCount = document.getElementById('backups-count');
  const backupsList = document.getElementById('backups-list');
  const emptySection = document.querySelector('.empty-state');
  const bulkSummarySection = document.getElementById('bulk-summary');
  const bulkSummaryToggle = document.getElementById('bulk-summary-toggle');
  const bulkSummaryList = document.getElementById('bulk-summary-list');
  const bulkSummaryMeta = document.getElementById('bulk-summary-meta');
  const bulkSummaryEmpty = document.getElementById('bulk-summary-empty');
  let bulkSummaryExpanded = false;

  if (!backupsCount || !backupsList) {
    return;
  }

  /* Slovensky komentar: Prepne viditelnost detailov sumarnej karty. */
  function toggleBulkSummary(explicitState) {
    if (!bulkSummaryToggle || !bulkSummaryList) {
      return;
    }
    const nextState = typeof explicitState === 'boolean' ? explicitState : !bulkSummaryExpanded;
    bulkSummaryExpanded = nextState;
    bulkSummaryList.hidden = !bulkSummaryExpanded;
    bulkSummaryToggle.setAttribute('aria-expanded', String(bulkSummaryExpanded));
    bulkSummaryToggle.textContent = bulkSummaryExpanded ? 'Hide details' : 'Show details';
  }

  /* Slovensky komentar: Orezanie URL pre zobrazenie. */
  function truncateUrl(url) {
    if (!url || typeof url !== 'string') {
      return '(unknown)';
    }
    const trimmed = url.trim();
    return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
  }

  /* Slovensky komentar: Vytvori riadok pre polozku sumarneho prehladu. */
  function buildBulkSummaryItem(entry) {
    if (!entry) {
      return null;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'bulk-summary-item';
    wrapper.setAttribute('role', 'listitem');

    const urlSpan = document.createElement('span');
    urlSpan.textContent = truncateUrl(entry.url);
    wrapper.appendChild(urlSpan);

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = entry.convoId ? entry.convoId : '∅';
    wrapper.appendChild(badge);

    const metrics = document.createElement('span');
    metrics.className = 'bulk-summary-metrics';
    const qLen = Number.isFinite(entry.qLen) ? entry.qLen : 0;
    const aLen = Number.isFinite(entry.aLen) ? entry.aLen : 0;
    const truncated = entry.truncated ? ' · truncated' : '';
    metrics.textContent = ` · q=${qLen} · aBytes=${aLen}${truncated}`;
    wrapper.appendChild(metrics);

    return wrapper;
  }

  /* Slovensky komentar: Zobrazi kartu so sumarom bulk backupu. */
  function renderBulkSummary(summary) {
    if (!bulkSummarySection || !bulkSummaryMeta || !bulkSummaryEmpty || !bulkSummaryList || !bulkSummaryToggle) {
      return;
    }

    if (!summary || typeof summary !== 'object') {
      bulkSummaryMeta.textContent = 'Bulk backup not executed yet.';
      bulkSummaryEmpty.textContent = 'No candidates were stored yet.';
      bulkSummaryEmpty.style.display = '';
      bulkSummaryList.innerHTML = '';
      bulkSummaryList.hidden = true;
      bulkSummaryToggle.disabled = true;
      toggleBulkSummary(false);
      return;
    }

    const dryRun = Array.isArray(summary.wouldWrite);
    const scanned = Number.isFinite(summary.scannedTabs) ? summary.scannedTabs : 0;
    const candidates = summary.stats && Number.isFinite(summary.stats.candidates)
      ? summary.stats.candidates
      : 0;
    const writtenCount = Array.isArray(summary.written) ? summary.written.length : 0;
    const wouldWriteCount = Array.isArray(summary.wouldWrite) ? summary.wouldWrite.length : 0;
    const skippedCount = Array.isArray(summary.skipped) ? summary.skipped.length : 0;
    const whenText = Number.isFinite(summary.timestamp)
      ? new Date(summary.timestamp).toLocaleString()
      : 'Unknown time';
    const writtenPart = dryRun
      ? `${writtenCount} written / ${wouldWriteCount} wouldWrite`
      : `${writtenCount} written`;

    bulkSummaryMeta.textContent = `${whenText} · ${scanned} scanned · ${candidates} candidates · ${writtenPart} · ${skippedCount} skipped`;

    const itemsSource = dryRun && wouldWriteCount ? summary.wouldWrite : summary.written;
    bulkSummaryList.innerHTML = '';

    if (!Array.isArray(itemsSource) || itemsSource.length === 0) {
      bulkSummaryEmpty.textContent = dryRun
        ? 'Dry run: nothing persisted.'
        : 'No new backups were written.';
      bulkSummaryEmpty.style.display = '';
      bulkSummaryList.hidden = true;
      bulkSummaryToggle.disabled = true;
      toggleBulkSummary(false);
      return;
    }

    bulkSummaryEmpty.style.display = 'none';
    const limited = itemsSource.slice(0, 10);
    limited.forEach((entry) => {
      const item = buildBulkSummaryItem(entry);
      if (item) {
        bulkSummaryList.appendChild(item);
      }
    });
    bulkSummaryToggle.disabled = false;
    toggleBulkSummary(false);
  }

  /* Slovensky komentar: Nacita sumar z local storage. */
  async function loadBulkSummaryFromStorage() {
    try {
      const stored = await chrome.storage.local.get({ last_bulk_backup: null });
      renderBulkSummary(stored.last_bulk_backup);
    } catch (error) {
      await Logger.log('warn', 'db', 'Failed to load bulk summary', {
        message: error && error.message
      });
    }
  }

  /* Slovensky komentar: Vyberie titulok alebo fallback z textu otazky. */
  function deriveTitle(backup) {
    if (!backup) {
      return 'Bez názvu';
    }
    if (backup.title && typeof backup.title === 'string' && backup.title.trim()) {
      return backup.title.trim();
    }
    if (backup.questionText && typeof backup.questionText === 'string' && backup.questionText.trim()) {
      const trimmed = backup.questionText.trim();
      return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
    }
    if (backup.convoId && typeof backup.convoId === 'string' && backup.convoId.trim()) {
      return backup.convoId.trim();
    }
    return 'Bez názvu';
  }

  /* Slovensky komentar: Formatovanie casovej peciatky. */
  function formatTimestamp(timestamp) {
    if (!Number.isFinite(timestamp)) {
      return 'Neznámy čas';
    }
    try {
      return new Date(timestamp).toLocaleString();
    } catch (_error) {
      return 'Neznámy čas';
    }
  }

  /* Slovensky komentar: Zobrazi alebo skryje prazdny stav. */
  function toggleEmptyState(show) {
    if (!emptySection) {
      return;
    }
    emptySection.style.display = show ? '' : 'none';
  }

  /* Slovensky komentar: Vytvori iframe so sandboxom pre odpoved. */
  function createAnswerFrame(answerHTML) {
    const frame = document.createElement('iframe');
    frame.className = 'backup-answer-frame';
    frame.setAttribute('sandbox', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.srcdoc = answerHTML || '';
    return frame;
  }

  /* Slovensky komentar: Pripravi radek so zakladnymi udajmi a detailnym nahliadnutim. */
  function buildBackupRow(backup) {
    const row = document.createElement('article');
    row.className = 'backup-row';
    row.setAttribute('role', 'listitem');

    const titleLine = document.createElement('div');
    titleLine.className = 'backup-row-title';
    titleLine.textContent = deriveTitle(backup);

    const metaLine = document.createElement('div');
    metaLine.className = 'backup-row-meta';
    const timestampSpan = document.createElement('span');
    timestampSpan.textContent = formatTimestamp(backup.timestamp);
    metaLine.appendChild(timestampSpan);
    if (backup && backup.answerTruncated) {
      const truncatedSpan = document.createElement('span');
      truncatedSpan.textContent = 'Odpoveď skrátená na 250 KB';
      metaLine.appendChild(truncatedSpan);
    }

    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'backup-toggle';
    toggleButton.textContent = 'Zobraziť detail';

    const preview = document.createElement('div');
    preview.className = 'backup-preview';
    preview.hidden = true;

    const questionBlock = document.createElement('p');
    questionBlock.className = 'backup-question';
    questionBlock.textContent = backup && backup.questionText
      ? backup.questionText
      : 'Otázka nebola zachytená.';

    const renderButton = document.createElement('button');
    renderButton.type = 'button';
    renderButton.className = 'backup-render';
    renderButton.textContent = 'Render answer (safe)';
    if (!backup || !backup.answerHTML) {
      renderButton.disabled = true;
      renderButton.textContent = 'Bez odpovede na renderovanie';
    }

    const answerWrapper = document.createElement('div');
    answerWrapper.className = 'backup-answer-wrapper';

    renderButton.addEventListener('click', () => {
      if (!backup || !backup.answerHTML) {
        return;
      }
      answerWrapper.innerHTML = '';
      const frame = createAnswerFrame(backup.answerHTML);
      answerWrapper.appendChild(frame);
    });

    preview.appendChild(questionBlock);
    preview.appendChild(renderButton);
    preview.appendChild(answerWrapper);

    toggleButton.addEventListener('click', () => {
      const willShow = preview.hidden;
      preview.hidden = !willShow;
      toggleButton.textContent = willShow ? 'Skryť detail' : 'Zobraziť detail';
    });

    row.appendChild(titleLine);
    row.appendChild(metaLine);
    row.appendChild(toggleButton);
    row.appendChild(preview);
    return row;
  }

  /* Slovensky komentar: Vykresli zoznam zaloz. */
  function renderBackups(backups) {
    backupsList.innerHTML = '';
    if (!Array.isArray(backups) || backups.length === 0) {
      toggleEmptyState(true);
      const empty = document.createElement('div');
      empty.className = 'backups-empty';
      empty.textContent = 'Zatiaľ neboli vytvorené žiadne zálohy.';
      backupsList.appendChild(empty);
      return;
    }
    toggleEmptyState(false);
    backups.forEach((backup) => {
      const row = buildBackupRow(backup);
      backupsList.appendChild(row);
    });
  }

  /* Slovensky komentar: Ziska pocet zaloz pre vypis. */
  async function readTotalCount(db) {
    const transaction = db.transaction([Database.constants.stores.backups], 'readonly');
    const store = transaction.objectStore(Database.constants.stores.backups);
    const countRequest = store.count();
    return await new Promise((resolve, reject) => {
      countRequest.onsuccess = () => resolve(countRequest.result);
      countRequest.onerror = () => reject(countRequest.error);
    });
  }

  /* Slovensky komentar: Obnovi statistiku a zoznam. */
  async function refreshBackups() {
    try {
      const db = await Database.initDB();
      let total = 0;
      try {
        total = await readTotalCount(db);
        backupsCount.textContent = `Počet záloh v úložisku: ${total}`;
      } catch (countError) {
        backupsCount.textContent = 'Nepodarilo sa načítať počet záloh.';
        await Logger.log('warn', 'db', 'Failed to count backups', {
          message: countError && countError.message
        });
      }

      let recent = [];
      try {
        recent = await Database.getRecentBackups(10);
      } catch (recentError) {
        await Logger.log('warn', 'db', 'Failed to load recent backups', {
          message: recentError && recentError.message
        });
      }

      renderBackups(recent);
      await Logger.log('info', 'db', 'Backups refreshed on searches page', {
        total,
        rendered: recent.length
      });
    } catch (error) {
      backupsCount.textContent = 'Nepodarilo sa načítať počet záloh.';
      toggleEmptyState(true);
      backupsList.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'backups-empty';
      empty.textContent = 'Zatiaľ neboli vytvorené žiadne zálohy.';
      backupsList.appendChild(empty);
      await Logger.log('error', 'db', 'Failed to initialize backups view', {
        message: error && error.message
      });
    }
  }

  if (bulkSummaryToggle) {
    bulkSummaryToggle.addEventListener('click', () => {
      toggleBulkSummary();
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'backups_updated') {
      refreshBackups();
    }
    if (message && message.type === 'bulk_backup_summary') {
      renderBulkSummary(message.summary);
    }
  });

  await loadBulkSummaryFromStorage();
  await refreshBackups();
})();
