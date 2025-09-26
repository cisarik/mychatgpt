(function () {
  const READY_LOG_PREFIX = '[Cleaner][content] Active tab ready';

  logReady();
  hookHistory();

  function logReady() {
    console.log(`${READY_LOG_PREFIX} ${location.href}`);
  }

  function hookHistory() {
    const wrap = (original) =>
      function wrapped(...args) {
        const result = original.apply(this, args);
        queueMicrotask(logReady);
        return result;
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', () => logReady());
  }
})();
