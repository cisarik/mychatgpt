/* Slovensky komentar: Stranka so zalohami zobrazi prazdny stav a pocet zaznamov. */
(async function () {
  const backupsCount = document.getElementById('backups-count');
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
    await Logger.log('info', 'db', 'Backups counted on searches page', { total });
  } catch (error) {
    backupsCount.textContent = 'Nepodarilo sa načítať počet záloh.';
    await Logger.log('error', 'db', 'Failed to inspect backups store', {
      message: error && error.message
    });
  }
})();

