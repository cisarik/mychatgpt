/* Slovensky komentar: Sluzobny worker inicializuje databazu a zaznamenava udalosti. */
importScripts('utils.js', 'db.js');

self.addEventListener('install', () => {
  /* Slovensky komentar: Preskoci cakanie, aby sa nova verzia aktivovala hned. */
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  /* Slovensky komentar: Po aktivacii pripravime databazu a zapiseme zaznam. */
  event.waitUntil((async () => {
    try {
      await Database.initDB();
      await Logger.log('info', 'background', 'Service worker activated');
    } catch (error) {
      await Logger.log('error', 'background', 'Activation failed', { message: error && error.message });
    }
    self.clients.claim();
  })());
});
