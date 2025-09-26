/* Slovensky komentar: Obsluha jednotneho povrchu s kartami a internymi odkazmi. */
(function () {
  const defaultTab = 'searches';
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
  const panels = new Map();
  let suppressHashChange = false;

  tabButtons.forEach((button) => {
    const tabName = button.dataset.tab;
    const panel = document.getElementById(`page-${tabName}`);
    if (panel) {
      panels.set(tabName, panel);
    }
  });

  panels.forEach((panel) => {
    const isActive = panel.classList.contains('active');
    panel.hidden = !isActive;
    panel.setAttribute('aria-hidden', String(!isActive));
  });

  /* Slovensky komentar: Aktivuje pozadovanu kartu, aktualizuje hash a fokus. */
  function activateTab(tabName, options = {}) {
    const { focus = true, updateHash = true } = options;
    const button = tabButtons.find((item) => item.dataset.tab === tabName);
    const panel = panels.get(tabName);
    if (!button || !panel) {
      return;
    }

    tabButtons.forEach((item) => {
      const isActive = item === button;
      item.classList.toggle('active', isActive);
      item.setAttribute('aria-selected', String(isActive));
      item.tabIndex = isActive ? 0 : -1;
    });

    panels.forEach((candidate, key) => {
      const isActive = key === tabName;
      candidate.classList.toggle('active', isActive);
      candidate.setAttribute('aria-hidden', String(!isActive));
      candidate.hidden = !isActive;
    });

    if (focus) {
      button.focus();
    }

    if (updateHash) {
      const nextHash = `#${tabName}`;
      if (window.location.hash !== nextHash) {
        suppressHashChange = true;
        window.location.hash = nextHash;
      }
    }
  }

  /* Slovensky komentar: Obsluha zmeny hash pre podporu deep linkov. */
  function syncFromHash({ focus = true, ensureHash = false } = {}) {
    const hashValue = window.location.hash.replace('#', '');
    if (panels.has(hashValue)) {
      activateTab(hashValue, { focus, updateHash: false });
      return;
    }
    activateTab(defaultTab, { focus, updateHash: ensureHash });
  }

  tabButtons.forEach((button, index) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      activateTab(button.dataset.tab);
    });

    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
        return;
      }
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const nextIndex = (index + delta + tabButtons.length) % tabButtons.length;
      const nextButton = tabButtons[nextIndex];
      if (nextButton) {
        activateTab(nextButton.dataset.tab);
      }
    });
  });

  window.addEventListener('hashchange', () => {
    if (suppressHashChange) {
      suppressHashChange = false;
      return;
    }
    syncFromHash({ focus: true, ensureHash: true });
  });

  if (tabButtons.length) {
    syncFromHash({ focus: false, ensureHash: true });
  }

  const testButton = document.getElementById('test-log-btn');
  if (testButton) {
    testButton.addEventListener('click', async () => {
      /* Slovensky komentar: Zapise testovaci zaznam na overenie logovania. */
      await Logger.log('info', 'popup', 'Manual test log triggered');
      testButton.textContent = 'Logged!';
      setTimeout(() => {
        testButton.textContent = 'Test log';
      }, 1500);
    });
  }
})();
