// @vitest-environment happy-dom
/**
 * Web Push in the service worker (apps/web/service-worker/sw.js).
 *
 * Like `offlineShellWorker.test.ts`, this loads the exact bytes that ship and
 * drives them against a fake `self`. Pinned here: a push shows a notification
 * unless an Owlat window is focused (no double alert), the test push always
 * shows, a burst collapses per tag, a click focuses an open window and routes
 * it in-app (or opens one), the click target can never leave the origin, and
 * the push-only registration (`/sw.js?shell=off`) neither answers fetches nor
 * keeps the shell caches.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workerSource = readFileSync(
	resolve(here, '..', '..', '..', 'service-worker', 'sw.js'),
	'utf8'
);

const ORIGIN = 'https://mail.example.com';

interface FakeClient {
	url: string;
	focused: boolean;
	visibilityState: 'visible' | 'hidden';
	focus: ReturnType<typeof vi.fn>;
	postMessage: ReturnType<typeof vi.fn>;
}

function client(overrides: Partial<FakeClient> = {}): FakeClient {
	return {
		url: `${ORIGIN}/dashboard`,
		focused: false,
		visibilityState: 'hidden',
		focus: vi.fn(async () => {}),
		postMessage: vi.fn(),
		...overrides,
	};
}

function makeSelf(
	options: {
		search?: string;
		windows?: FakeClient[];
		cacheNames?: string[];
		/** This registration's push subscription endpoint. */
		endpoint?: string;
	} = {}
) {
	const shown: Array<{ tag?: string; close: ReturnType<typeof vi.fn> }> = [];
	const listeners = new Map<string, (event: unknown) => void>();
	const cacheNames = new Set(options.cacheNames ?? []);
	const self = {
		location: { origin: ORIGIN, search: options.search ?? '' },
		caches: {
			keys: vi.fn(async () => [...cacheNames]),
			delete: vi.fn(async (name: string) => cacheNames.delete(name)),
			open: vi.fn(async () => ({
				match: async () => undefined,
				put: async () => {},
				add: async () => {},
			})),
		},
		fetch: vi.fn(async () => new Response('{}', { status: 404 })),
		clients: {
			claim: vi.fn(async () => {}),
			matchAll: vi.fn(async () => options.windows ?? []),
			openWindow: vi.fn(async () => null),
		},
		registration: {
			showNotification: vi.fn(async (_title: string, opts: { tag?: string }) => {
				shown.push({ tag: opts.tag, close: vi.fn() });
			}),
			getNotifications: vi.fn(async (filter: { tag?: string } = {}) =>
				shown.filter((notification) => !filter.tag || notification.tag === filter.tag)
			),
			pushManager: {
				getSubscription: vi.fn(async () =>
					options.endpoint ? { endpoint: options.endpoint } : null
				),
			},
		},
		skipWaiting: vi.fn(async () => {}),
		addEventListener: (type: string, handler: (event: unknown) => void) => {
			listeners.set(type, handler);
		},
	};
	new Function('self', workerSource)(self);
	return { self, listeners, cacheNames, shown };
}

/** Fire an extendable event and wait for the work it handed to `waitUntil`. */
async function fire(listeners: Map<string, (event: unknown) => void>, type: string, event: object) {
	let work: Promise<unknown> = Promise.resolve();
	listeners.get(type)?.({ ...event, waitUntil: (value: Promise<unknown>) => (work = value) });
	await work;
}

function pushData(payload: unknown) {
	return { json: () => payload };
}

const MAIL = {
	title: 'Alice Example',
	body: 'Lunch on Friday?',
	tag: 'mail:thread_1',
	url: '/dashboard/postbox/inbox/m1?mailbox=b1',
};

describe('push', () => {
	it('shows the notification, collapsed per tag, when no Owlat window is in front', async () => {
		const { self, listeners } = makeSelf({ windows: [client()] });
		await fire(listeners, 'push', { data: pushData(MAIL) });
		expect(self.registration.showNotification).toHaveBeenCalledWith('Alice Example', {
			body: 'Lunch on Friday?',
			tag: 'mail:thread_1',
			renotify: true,
			icon: '/icons/icon-192.png',
			badge: '/icons/badge-96.png',
			data: { url: MAIL.url },
		});
	});

	it('stays quiet while someone is looking at Owlat — the app already shows it', async () => {
		const { self, listeners } = makeSelf({
			windows: [client({ focused: true, visibilityState: 'visible' })],
		});
		await fire(listeners, 'push', { data: pushData(MAIL) });
		expect(self.registration.showNotification).not.toHaveBeenCalled();
	});

	it('on Safari, shows the notification silently and closes it at once — Safari revokes silent pushes', async () => {
		const { self, listeners, shown } = makeSelf({
			windows: [client({ focused: true, visibilityState: 'visible' })],
			endpoint: 'https://web.push.apple.com/QGuQyavXutnMA',
		});
		await fire(listeners, 'push', { data: pushData(MAIL) });
		expect(self.registration.showNotification).toHaveBeenCalledWith(
			'Alice Example',
			expect.objectContaining({ tag: 'owlat-in-app', silent: true, renotify: false })
		);
		expect(shown).toHaveLength(1);
		expect(shown[0]!.close).toHaveBeenCalled();
	});

	it('elsewhere, a focused window means no notification at all', async () => {
		const { self, listeners } = makeSelf({
			windows: [client({ focused: true, visibilityState: 'visible' })],
			endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
		});
		await fire(listeners, 'push', { data: pushData(MAIL) });
		expect(self.registration.showNotification).not.toHaveBeenCalled();
	});

	it('always shows the test notification', async () => {
		const { self, listeners } = makeSelf({
			windows: [client({ focused: true, visibilityState: 'visible' })],
		});
		await fire(listeners, 'push', {
			data: pushData({ title: 'Notifications are on', body: 'x', tag: 'test', url: '/' }),
		});
		expect(self.registration.showNotification).toHaveBeenCalledTimes(1);
	});

	it('shows something sane for a malformed payload and never links off-site', async () => {
		const { self, listeners } = makeSelf();
		await fire(listeners, 'push', {
			data: {
				json: () => {
					throw new Error('not json');
				},
			},
		});
		await fire(listeners, 'push', {
			data: pushData({ title: 'x', url: 'https://evil.example.com/' }),
		});
		await fire(listeners, 'push', { data: pushData({ title: 'y', url: '//evil.example.com' }) });
		// URL parsing reads a backslash as a slash: `/\host` is `//host`.
		await fire(listeners, 'push', { data: pushData({ title: 'z', url: '/\\evil.example.com' }) });
		const calls = self.registration.showNotification.mock.calls as unknown as Array<
			[string, { data: { url: string }; renotify: boolean }]
		>;
		expect(calls[0]![0]).toBe('Owlat');
		expect(calls[0]![1].renotify).toBe(false);
		expect(calls[1]![1].data.url).toBe('/dashboard');
		expect(calls[2]![1].data.url).toBe('/dashboard');
		expect(calls[3]![1].data.url).toBe('/dashboard');
	});

	it('badges with a transparent silhouette, never an opaque icon', () => {
		// Android draws the badge from its alpha channel alone: an opaque icon
		// (the maskable one) renders as a solid white square in the status bar.
		const match = /badge: '([^']+)'/.exec(workerSource);
		expect(match?.[1]).toBe('/icons/badge-96.png');
		const png = readFileSync(resolve(here, '..', '..', '..', 'public', 'icons', 'badge-96.png'));
		// IHDR colour type: 3 = palette (alpha via tRNS) or 6 = RGBA; never opaque RGB.
		const colourType = png[25];
		expect([3, 6]).toContain(colourType);
		if (colourType === 3) expect(png.includes(Buffer.from('tRNS'))).toBe(true);
	});
});

describe('notificationclick', () => {
	it('focuses an open window and routes it in-app', async () => {
		const open = client();
		const { self, listeners } = makeSelf({ windows: [open] });
		const notification = { close: vi.fn(), data: { url: MAIL.url } };
		await fire(listeners, 'notificationclick', { notification });
		expect(notification.close).toHaveBeenCalled();
		expect(open.focus).toHaveBeenCalled();
		expect(open.postMessage).toHaveBeenCalledWith({ type: 'owlat:navigate', path: MAIL.url });
		expect(self.clients.openWindow).not.toHaveBeenCalled();
	});

	it('opens a window when none is around', async () => {
		const { self, listeners } = makeSelf({ windows: [] });
		await fire(listeners, 'notificationclick', {
			notification: { close: vi.fn(), data: { url: '/dashboard/chat/r1' } },
		});
		expect(self.clients.openWindow).toHaveBeenCalledWith('/dashboard/chat/r1');
	});
});

describe('push-only registration (/sw.js?shell=off)', () => {
	it('answers no fetch at all', () => {
		const { listeners } = makeSelf({ search: '?shell=off' });
		const respondWith = vi.fn();
		listeners.get('fetch')?.({
			request: { method: 'GET', mode: 'navigate', url: `${ORIGIN}/dashboard` },
			respondWith,
		});
		expect(respondWith).not.toHaveBeenCalled();
	});

	it('drops every shell cache on activation and precaches nothing', async () => {
		const { self, listeners, cacheNames } = makeSelf({
			search: '?shell=off',
			cacheNames: ['owlat-shell-build-one', 'someone-else'],
		});
		await fire(listeners, 'install', {});
		expect(self.caches.open).not.toHaveBeenCalled();
		await fire(listeners, 'activate', {});
		expect([...cacheNames]).toEqual(['someone-else']);
		expect(self.clients.claim).toHaveBeenCalled();
	});

	it('still shows notifications', async () => {
		const { self, listeners } = makeSelf({ search: '?shell=off' });
		await fire(listeners, 'push', { data: pushData(MAIL) });
		expect(self.registration.showNotification).toHaveBeenCalledTimes(1);
	});
});
