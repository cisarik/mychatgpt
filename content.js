/* Slovensky komentar: Obsahovy skript reaguje na ping bez zmeny DOM. */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'ping') {
    return undefined;
  }
  const traceId = message.traceId;
  const payload = {
    ok: true,
    traceId,
    url: window.location.href,
    title: document.title,
    markers: {
      hasAppRoot: Boolean(document.querySelector('#__next')),
      hasComposer: Boolean(document.querySelector('textarea, [contenteditable]'))
    }
  };
  sendResponse(payload);
  return undefined;
});
