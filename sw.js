// Keeps the phone app available offline. All files of one version are stored together and a new
// version is only switched to when it has arrived completely, so old and new files never mix.
const PREFIX = 'opening-trainer-';
const scoped = path => new URL(path, self.registration.scope).href;

async function fetchManifest() {
  const res = await fetch(scoped('precache.json'), { cache: 'no-store' });
  if (!res.ok) throw new Error('no manifest');
  return res.json();
}

async function install(manifest) {
  const name = PREFIX + manifest.version;
  const cache = await caches.open(name);
  await Promise.all(manifest.files.map(async file => {
    const res = await fetch(scoped(file), { cache: 'no-store' });
    if (!res.ok) throw new Error(`Could not fetch ${file}`);
    await cache.put(scoped(file), res);
  }));
  return name;
}

async function removeOthers(keep) {
  for (const key of await caches.keys()) {
    if (key.startsWith(PREFIX) && key !== keep) await caches.delete(key);
  }
}

async function currentCache() {
  const keys = (await caches.keys()).filter(k => k.startsWith(PREFIX));
  return keys.length ? caches.open(keys[keys.length - 1]) : null;
}

self.addEventListener('install', event => {
  event.waitUntil(fetchManifest().then(install).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(fetchManifest().then(m => removeOthers(PREFIX + m.version)).catch(() => {}).then(() => self.clients.claim()));
});

/** Look for a newer version in the background; it is used from the next start on. */
let checking = null;
function checkForUpdate() {
  if (checking) return checking;
  checking = (async () => {
    const manifest = await fetchManifest();
    const name = PREFIX + manifest.version;
    if (!(await caches.has(name))) {
      await install(manifest);
      await removeOthers(name);
    }
  })().catch(() => {}).finally(() => { checking = null; });
  return checking;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  const isPage = request.mode === 'navigate';
  event.respondWith((async () => {
    const cache = await currentCache();
    const url = new URL(request.url);
    url.hash = '';
    url.search = '';
    const hit = cache && await cache.match(isPage ? scoped('index.html') : url.href);
    if (isPage) event.waitUntil(checkForUpdate());
    return hit || fetch(request);
  })());
});
