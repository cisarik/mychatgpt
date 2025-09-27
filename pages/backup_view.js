/* Slovensky komentar: Stránka detailu zálohy načíta záznam podľa ID a umožní bezpečné zobrazenie odpovede. */
(async function () {
  const params = new URLSearchParams(window.location.search || '');
  const backupId = params.get('id');
  const statusCard = document.getElementById('status-card');
  const statusTitle = document.getElementById('status-title');
  const statusText = document.getElementById('status-text');
  const backLink = document.getElementById('back-link');
  const contentSection = document.getElementById('backup-content');
  const queryButton = document.getElementById('query-button');
  const metaBar = document.getElementById('meta-bar');
  const questionTextEl = document.getElementById('question-text');
  const renderButton = document.getElementById('render-answer-btn');
  const answerContainer = document.getElementById('answer-container');
  const answerHint = document.getElementById('answer-hint');

  /* Slovensky komentar: Preklik späť na zoznam záloh. */
  if (backLink && typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
    backLink.href = chrome.runtime.getURL('popup/popup.html#searches');
  }

  /* Slovensky komentar: Zobrazí chybový stav a skryje obsah. */
  function showStatus(title, message) {
    if (statusTitle) {
      statusTitle.textContent = title;
    }
    if (statusText) {
      statusText.textContent = message;
    }
    if (statusCard) {
      statusCard.hidden = false;
    }
    if (contentSection) {
      contentSection.hidden = true;
    }
  }

  /* Slovensky komentar: Vytvorí pilulku pre meta lištu. */
  function appendMetaPill(text, variant) {
    if (!metaBar || !text) {
      return;
    }
    const pill = document.createElement('span');
    pill.className = 'meta-pill';
    if (variant) {
      pill.classList.add(`meta-pill-${variant}`);
    }
    pill.setAttribute('role', 'listitem');
    pill.textContent = text;
    metaBar.appendChild(pill);
  }

  /* Slovensky komentar: Formátovanie časovej známky. */
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

  /* Slovensky komentar: Dekoruje HTML odpovede pre iframe. */
  function decorateAnswerHtml(rawHtml) {
    if (typeof rawHtml !== 'string' || !rawHtml.trim()) {
      return '';
    }
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(rawHtml, 'text/html');
      const anchors = doc.querySelectorAll('a');
      anchors.forEach((anchor) => {
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener');
        const existingClass = anchor.getAttribute('class');
        if (existingClass && existingClass.includes('tablike')) {
          anchor.setAttribute('class', existingClass);
        } else if (existingClass) {
          anchor.setAttribute('class', `${existingClass} tablike`.trim());
        } else {
          anchor.setAttribute('class', 'tablike');
        }
      });
      return doc.body.innerHTML;
    } catch (_error) {
      return rawHtml;
    }
  }

  /* Slovensky komentar: Poskladá srcdoc s bezpečnými štýlmi. */
  function buildAnswerSrcdoc(answerHtml) {
    const styledAnswer = decorateAnswerHtml(answerHtml || '');
    const tablikeStyles = `:root {\n  color-scheme: dark;\n  --bg: #0b1623;\n  --text: #f5f7fb;\n  --muted: #a8b5cc;\n  --accent: #10a37f;\n  --accent-strong: #15c296;\n  --border: rgba(255, 255, 255, 0.16);\n}\nbody {\n  margin: 0;\n  padding: 18px;\n  background: var(--bg);\n  color: var(--text);\n  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;\n  line-height: 1.6;\n}\np {\n  margin: 0 0 12px;\n}\na {\n  color: var(--accent);\n  text-decoration: none;\n}\na.tablike {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  padding: 6px 14px;\n  border-radius: 10px;\n  border: 1px solid var(--border);\n  background: linear-gradient(140deg, rgba(16, 163, 127, 0.16), rgba(21, 194, 150, 0.08));\n  color: var(--accent-strong);\n  font-weight: 600;\n  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;\n}\na.tablike:hover, a.tablike:focus {\n  color: var(--accent);\n  border-color: var(--accent);\n  background: linear-gradient(140deg, rgba(21, 194, 150, 0.24), rgba(16, 163, 127, 0.12));\n}\n`; // Slovensky komentar: Zdieľané tab-like štýly pre odkazy.
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><base target="_blank" /><style>${tablikeStyles}</style></head><body>${styledAnswer}</body></html>`;
  }

  if (!backupId) {
    showStatus('Záloha sa nenašla', 'Parameter „id“ v URL chýba.');
    return;
  }

  let record = null;
  try {
    record = await Database.getBackupById(backupId);
  } catch (error) {
    const message = error && error.message ? error.message : 'Načítanie zlyhalo.';
    await Logger.log('warn', 'db', 'Backup view load failed', { id: backupId, message });
    showStatus('Záloha sa nenačítala', message);
    return;
  }

  if (!record) {
    await Logger.log('info', 'db', 'Backup view missing record', { id: backupId });
    showStatus('Záloha sa nenašla', 'Záznam neexistuje alebo bol odstránený.');
    return;
  }

  if (statusCard) {
    statusCard.hidden = true;
  }
  if (contentSection) {
    contentSection.hidden = false;
  }

  const questionText = record.questionText && typeof record.questionText === 'string' && record.questionText.trim()
    ? record.questionText.trim()
    : '(untitled)';

  if (queryButton) {
    queryButton.textContent = questionText;
    if (record.questionText && record.questionText.trim()) {
      queryButton.removeAttribute('aria-disabled');
      queryButton.classList.remove('disabled');
      queryButton.addEventListener('click', () => {
        const encoded = encodeURIComponent(questionText);
        window.open(`https://www.google.com/search?q=${encoded}`, '_blank', 'noopener,noreferrer');
      });
    } else {
      queryButton.setAttribute('aria-disabled', 'true');
      queryButton.classList.add('disabled');
    }
  }

  if (metaBar) {
    metaBar.innerHTML = '';
    appendMetaPill(formatTimestamp(record.timestamp), 'strong');
    if (record.convoId) {
      appendMetaPill(record.convoId);
    }
    if (record.answerTruncated) {
      appendMetaPill('Odpoveď skrátená na 250 KB', 'warn');
    }
  }

  if (questionTextEl) {
    questionTextEl.textContent = record.questionText && record.questionText.trim()
      ? record.questionText.trim()
      : 'Otázka nebola zachytená.';
  }

  if (renderButton) {
    if (record.answerHTML) {
      renderButton.removeAttribute('aria-disabled');
      renderButton.classList.remove('disabled');
      renderButton.addEventListener('click', () => {
        if (!answerContainer) {
          return;
        }
        answerContainer.innerHTML = '';
        const frame = document.createElement('iframe');
        frame.className = 'answer-frame';
        frame.setAttribute('sandbox', '');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.srcdoc = buildAnswerSrcdoc(record.answerHTML);
        answerContainer.appendChild(frame);
      });
    } else {
      renderButton.textContent = 'Bez odpovede na renderovanie';
      renderButton.setAttribute('aria-disabled', 'true');
      renderButton.classList.add('disabled');
    }
  }

  if (answerHint) {
    answerHint.textContent = record.answerTruncated
      ? 'Odpoveď bola skrátená na 250 KB a vykresľuje sa v sandboxe.'
      : 'Odpoveď sa vykreslí v sandboxovom iframe.';
  }

  await Logger.log('info', 'db', 'Backup view opened', {
    id: record.id,
    hasAnswer: Boolean(record.answerHTML),
    truncated: Boolean(record.answerTruncated)
  });
})();
