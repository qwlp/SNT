import { build, files, version } from '$service-worker';

const CACHE_NAME = `snt-${version}`;
const ASSETS = [...build, ...files];

self.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then(async (keys) => {
			await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
		})
	);
});

self.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') {
		return;
	}

	event.respondWith(
		caches.match(event.request).then((response) => {
			if (response) {
				return response;
			}

			return fetch(event.request)
				.then((networkResponse) => {
					const clone = networkResponse.clone();
					void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
					return networkResponse;
				})
				.catch(() => new Response('Offline', { status: 503 }));
		})
	);
});
