/* Slovensky komentar: Obsluha kariet a testovacieho logu v popup okne. */
(function () {
  const tabs = Array.from(document.querySelectorAll('.tab-button'));
  const sections = new Map([
    ['searches', document.getElementById('section-searches')],
    ['settings', document.getElementById('section-settings')],
    ['debug', document.getElementById('section-debug')]
  ]);

  function activateTab(target) {
    tabs.forEach((button) => {
      const isActive = button.dataset.target === target;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', String(isActive));
    });
    sections.forEach((section, key) => {
      section.classList.toggle('active', key === target);
    });
  }

  tabs.forEach((button) => {
    button.addEventListener('click', () => {
      activateTab(button.dataset.target);
    });
  });

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
