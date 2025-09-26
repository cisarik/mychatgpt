/* Slovensky komentar: Stranka so zalohami zobrazi prazdny stav a pocet zaznamov. */
(async function () {
  const backupsCount = document.getElementById('backups-count');
  const backupsList = document.getElementById('backups-list');
  const emptySection = document.querySelector('.empty-state');

  if (!backupsCount || !backupsList) {
    return;
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

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'backups_updated') {
      refreshBackups();
    }
  });

  await refreshBackups();
})();
