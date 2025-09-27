/* Slovensky komentar: Detail zalohy zobrazi ulozenu odpoved priamo na stranke so spevnenymi odkazmi. */

const ALLOWED = {
  TAGS: new Set([
    'p',
    'div',
    'span',
    'a',
    'ul',
    'ol',
    'li',
    'strong',
    'em',
    'code',
    'pre',
    'blockquote',
    'img',
    'br',
    'hr',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td'
  ]),
  ATTR: new Set(['href', 'src', 'alt', 'title'])
};

/* Slovensky komentar: Sanitizuje HTML a odstrani nebezpecne prvky. */
function sanitizeAndHarden(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  doc.querySelectorAll('script, style').forEach((node) => node.remove());
  doc.querySelectorAll('*').forEach((el) => {
    const tagName = el.tagName.toLowerCase();
    if (!ALLOWED.TAGS.has(tagName)) {
      const parent = el.parentNode;
      if (!parent) {
        el.remove();
        return;
      }
      while (el.firstChild) {
        parent.insertBefore(el.firstChild, el);
      }
      el.remove();
      return;
    }
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || !ALLOWED.ATTR.has(name)) {
        el.removeAttribute(attr.name);
      }
    });
    if (tagName === 'a') {
      const href = el.getAttribute('href') || '';
      if (/^\s*javascript:/i.test(href) || /^\s*data:/i.test(href)) {
        el.removeAttribute('href');
      }
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener');
      el.classList.add('tablike', 'answer-link');
      el.setAttribute('role', 'button');
    }
    if (tagName === 'img') {
      const src = el.getAttribute('src') || '';
      if (/^\s*(javascript:|data:)/i.test(src)) {
        el.remove();
      }
    }
  });
  return doc.body.innerHTML;
}

/* Slovensky komentar: Vytvori badge pre meta sekciu. */
function appendMetaPill(container, text, variant) {
  if (!container || !text) {
    return;
  }
  const pill = document.createElement('span');
  pill.className = 'meta-pill';
  if (variant) {
    pill.classList.add(`meta-pill-${variant}`);
  }
  pill.setAttribute('role', 'listitem');
  pill.textContent = text;
  container.appendChild(pill);
}

/* Slovensky komentar: Nastavi text v odpovedi pre pripad chyby. */
function showAnswerMessage(target, message) {
  if (!target) {
    return;
  }
  target.textContent = message;
}

(async function initBackupView() {
  const params = new URLSearchParams(window.location.search || '');
  const backupId = params.get('id');
  const queryButton = document.getElementById('queryLaunch');
  const metaBar = document.getElementById('meta');
  const answerEl = document.getElementById('answer');

  if (!backupId) {
    showAnswerMessage(answerEl, 'Záznam sa nenašiel.');
    await Logger.log('warn', 'ui', 'Backup view missing id parameter');
    return;
  }

  let record = null;
  try {
    record = await Database.getBackupById(backupId);
  } catch (error) {
    const message = error && error.message ? error.message : 'Načítanie zlyhalo.';
    showAnswerMessage(answerEl, message);
    await Logger.log('error', 'db', 'Backup view load failed', { id: backupId, message });
    return;
  }

  if (!record) {
    showAnswerMessage(answerEl, 'Záloha neexistuje alebo bola odstránená.');
    await Logger.log('info', 'db', 'Backup view missing record', { id: backupId });
    return;
  }

  const questionRaw = typeof record.questionText === 'string' ? record.questionText.trim() : '';
  const questionText = questionRaw || '(untitled)';
  const fallbackDate = () => {
    try {
      return new Date(record.timestamp).toLocaleString();
    } catch (_error) {
      return 'Neznámy čas';
    }
  };
  const formattedTimestamp = typeof formatDate === 'function' ? formatDate(record.timestamp) : fallbackDate();

  if (queryButton) {
    queryButton.textContent = questionText;
    const hasQuery = Boolean(questionRaw);
    if (hasQuery) {
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
    appendMetaPill(metaBar, formattedTimestamp, 'strong');
    if (record.convoId) {
      appendMetaPill(metaBar, record.convoId);
    }
    if (record.answerTruncated) {
      appendMetaPill(metaBar, '(truncated)', 'warn');
    }
  }

  if (record.answerHTML) {
    const hardened = sanitizeAndHarden(record.answerHTML);
    if (hardened && answerEl) {
      answerEl.innerHTML = hardened;
    } else {
      showAnswerMessage(answerEl, 'Odpoveď neobsahuje žiadny obsah.');
    }
  } else {
    showAnswerMessage(answerEl, 'Žiadna odpoveď na zobrazenie.');
  }

  await Logger.log('info', 'db', 'Backup view opened', {
    id: record.id,
    hasAnswer: Boolean(record.answerHTML),
    truncated: Boolean(record.answerTruncated)
  });
})();
