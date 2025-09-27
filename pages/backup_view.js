/* Slovensky komentar: Inicializuje detail zalohy a vykresli ulozenu odpoved priamo na stranke. */

document.addEventListener('DOMContentLoaded', () => {
  const queryLaunch = document.getElementById('queryLaunch');
  const meta = document.getElementById('meta');
  const answer = document.getElementById('answer');

  /* Slovensky komentar: Zobrazi spravu v odpovedi pri chybe alebo prazdnom stave. */
  function showInlineMessage(message) {
    if (!answer) {
      return;
    }
    answer.textContent = message;
  }

  /* Slovensky komentar: Bezpecne vrati text otazky s default hodnotou. */
  function normalizeQuestion(text) {
    if (typeof text !== 'string') {
      return '(untitled)';
    }
    const trimmed = text.trim();
    return trimmed ? trimmed : '(untitled)';
  }

  (async () => {
    try {
      const params = new URL(location.href).searchParams;
      const id = params.get('id');
      if (!id) {
        showInlineMessage('Záznam sa nenašiel.');
        return;
      }

      if (typeof db === 'undefined' || typeof db.getBackupById !== 'function') {
        showInlineMessage('Databáza nie je dostupná.');
        return;
      }

      const record = await db.getBackupById(id);
      if (!record) {
        showInlineMessage('Záloha nebola nájdená.');
        return;
      }

      const questionText = normalizeQuestion(record.questionText);
      if (queryLaunch) {
        queryLaunch.textContent = questionText;
        queryLaunch.addEventListener('click', () => {
          const q = encodeURIComponent(record.questionText || '');
          chrome.tabs.create({ url: `https://www.google.com/search?q=${q}` });
        });
      }

      if (meta) {
        const formatted = typeof formatDate === 'function'
          ? formatDate(record.timestamp)
          : new Date(record.timestamp || Date.now()).toLocaleString();
        const convoText = record.convoId ? record.convoId : 'no-convo';
        const parts = [formatted, convoText];
        if (record.answerTruncated) {
          parts.push('(truncated)');
        }
        meta.textContent = parts.join('  •  ');
      }

      const answerHTML = typeof record.answerHTML === 'string' ? record.answerHTML : '';
      if (!answerHTML.trim()) {
        showInlineMessage('Žiadna odpoveď na zobrazenie.');
        return;
      }

      const tmp = document.createElement('div');
      tmp.innerHTML = answerHTML;
      tmp.querySelectorAll('a').forEach((anchor) => {
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener');
        anchor.classList.add('tablike');
        anchor.setAttribute('role', 'button');
      });

      if (answer) {
        answer.innerHTML = '';
        while (tmp.firstChild) {
          answer.appendChild(tmp.firstChild);
        }
      }
    } catch (error) {
      showInlineMessage('Načítanie zlyhalo.');
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        Logger.log('error', 'db', 'Backup view render failed', {
          message: error && error.message ? error.message : String(error)
        });
      }
    }
  })();
});
