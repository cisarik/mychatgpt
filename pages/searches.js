/* Slovensky komentar: Stranka so zalohami zobrazi prazdny stav a pocet zaznamov. */
(async function () {
  const backupsCount = document.getElementById('backups-count');
  const backupsList = document.getElementById('backups-list');

  if (!backupsCount) {
    return;
  }

  /* Slovensky komentar: Prevedie zaznam na HTML blok v prehlade. */
  function renderBackupRow(container, backup) {
    const row = document.createElement('article');
    row.className = 'backup-row';
    row.setAttribute('role', 'listitem');

    const title = document.createElement('div');
    title.className = 'backup-row-title';
    const titleText = backup && typeof backup.title === 'string' && backup.title.trim()
      ? backup.title.trim()
      : backup && typeof backup.convoId === 'string' && backup.convoId.trim()
        ? backup.convoId.trim()
        : 'Bez názvu';
    title.textContent = titleText;

    const meta = document.createElement('div');
    meta.className = 'backup-row-meta';
    const timestampValue = Number.isFinite(backup && backup.timestamp)
      ? new Date(backup.timestamp).toLocaleString()
      : 'Neznámy čas';
    const idValue = backup && backup.id
      ? String(backup.id)
      : backup && backup.convoId
        ? String(backup.convoId)
        : 'neznáme-id';
    const metaItems = [timestampValue, `ID: ${idValue}`];
    if (backup && backup.category) {
      metaItems.push(`Kategória: ${backup.category}`);
    }
    metaItems.forEach((itemText) => {
      const span = document.createElement('span');
      span.textContent = itemText;
      meta.appendChild(span);
    });

    row.append(title, meta);
    container.appendChild(row);
  }

  /* Slovensky komentar: Zobrazi stav, ak nie su dostupne ziadne zaznamy. */
  function renderEmptyBackups(container) {
    const empty = document.createElement('div');
    empty.className = 'backups-empty';
    empty.textContent = 'Zatiaľ neboli vytvorené žiadne zálohy.';
    container.appendChild(empty);
  }

  /* Slovensky komentar: Načíta posledné zálohy zoradené podľa času. */
  async function loadRecentBackups(db, limit = 5) {
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction([Database.constants.stores.backups], 'readonly');
        const store = transaction.objectStore(Database.constants.stores.backups);
        const index = store.index('byTimestamp');
        const request = index.openCursor(null, 'prev');
        const collected = [];

        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor && collected.length < limit) {
            collected.push(cursor.value);
            cursor.continue();
            return;
          }
          resolve(collected);
        };

        request.onerror = () => {
          reject(request.error);
        };

        transaction.onerror = () => {
          reject(transaction.error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  try {
    const db = await Database.initDB();
    const transaction = db.transaction([Database.constants.stores.backups], 'readonly');
    const store = transaction.objectStore(Database.constants.stores.backups);
    const countRequest = store.count();
    const total = await new Promise((resolve, reject) => {
      countRequest.onsuccess = () => resolve(countRequest.result);
      countRequest.onerror = () => reject(countRequest.error);
    });
    backupsCount.textContent = `Počet záloh v úložisku: ${total}`;

    if (backupsList) {
      backupsList.innerHTML = '';
      try {
        const recent = await loadRecentBackups(db, 5);
        if (recent.length === 0) {
          renderEmptyBackups(backupsList);
        } else {
          recent.forEach((item) => renderBackupRow(backupsList, item));
        }
        await Logger.log('info', 'db', 'Backups counted on searches page', {
          total,
          previewCount: recent.length
        });
      } catch (listError) {
        renderEmptyBackups(backupsList);
        await Logger.log('warn', 'db', 'Failed to render recent backups preview', {
          message: listError && listError.message
        });
      }
    } else {
      await Logger.log('info', 'db', 'Backups counted on searches page', { total });
    }
  } catch (error) {
    backupsCount.textContent = 'Nepodarilo sa načítať počet záloh.';
    if (backupsList) {
      backupsList.innerHTML = '';
      renderEmptyBackups(backupsList);
    }
    await Logger.log('error', 'db', 'Failed to inspect backups store', {
      message: error && error.message
    });
  }
})();

