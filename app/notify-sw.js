// Shows "the reply is ready" notifications for 轻酒馆 (see src/attention.js) and opens the app when one is tapped.
// It handles no requests and caches nothing.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        // The scope is this app's own folder, whatever name the extension was installed under.
        const open = windows.find(client => client.url.startsWith(self.registration.scope));
        if (open) return open.focus();
        return self.clients.openWindow(event.notification.data?.url || './');
    })());
});
