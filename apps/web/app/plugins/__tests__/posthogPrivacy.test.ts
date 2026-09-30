import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type ShallowRef } from 'vue';
import { createRouter, createWebHistory, type Router } from 'vue-router';
import type * as PostHogModule from 'posthog-js';
import type { PostHog } from 'posthog-js';

/**
 * The real plugin and the real posthog-js, with the transport intercepted at
 * `_send_request` (the one door every request and event batch leaves by). A
 * sentinel planted in a query string, a fragment and a dynamic path segment
 * must not appear in anything handed to it, whatever produced the event.
 */

const SENTINELS = ['QUERY_SENTINEL', 'FRAGMENT_SENTINEL', 'PATH_SENTINEL'];

// A fresh client per plugin load: the package's default export is a singleton
// that cannot be initialised twice.
vi.mock('posthog-js', async (importOriginal) => {
	const actual = await importOriginal<typeof PostHogModule>();
	return { ...actual, default: new actual.PostHog() };
});

type Plugin = () => { provide: { posthog: ShallowRef<PostHog | null> } };
type Request = { url: string; data?: unknown };

const empty = { render: () => null };

/** A few records shaped like Nuxt's generated ones. */
function makeRouter(): Router {
	return createRouter({
		history: createWebHistory(),
		routes: [
			{ name: 'index', path: '/', component: empty },
			{ name: 'dashboard', path: '/dashboard', component: empty },
			{
				name: 'dashboard-postbox-folder-messageId',
				path: '/dashboard/postbox/:folder()/:messageId?',
				component: empty,
			},
			{ name: 'auth-login', path: '/auth/login', component: empty },
			{ name: 'auth-reset-password', path: '/auth/reset-password', component: empty },
			{ name: 'share', path: '/share', component: empty },
		],
	});
}

let requests: Request[];
let current: PostHog | null = null;

async function loadPlugin(router: Router) {
	const flag = ref(false);
	vi.stubGlobal('defineNuxtPlugin', (def: unknown) => def);
	vi.stubGlobal('useRuntimeConfig', () => ({
		public: { posthogApiKey: 'phc_test', posthogHost: 'https://posthog.example' },
	}));
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (key: string) => key === 'analytics.posthog' && flag.value,
	}));
	vi.stubGlobal('useRouter', () => router);
	vi.resetModules();
	const mod = await import('../posthog.client');
	// Same registry as the plugin's own dynamic import, so the same instance.
	const { default: posthog } = await import('posthog-js');
	current = posthog;
	vi.spyOn(posthog, '_send_request').mockImplementation((options: Request) => {
		requests.push({ url: options.url, data: options.data });
	});
	return { plugin: mod.default as unknown as Plugin, flag, posthog };
}

async function settle() {
	await nextTick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await nextTick();
}

/** Push every queued batch through the transport, as a closing tab does. */
function flush() {
	window.dispatchEvent(new Event('pagehide'));
	window.dispatchEvent(new Event('unload'));
}

/**
 * Click the way a browser would for autocapture. posthog-js walks
 * `element.attributes` with `for…in`, which happy-dom's NamedNodeMap does not
 * survive, so the attributes are handed over as an array for the click only.
 */
function click(element: Element) {
	const attributes = Object.getOwnPropertyDescriptor(Element.prototype, 'attributes')!;
	Object.defineProperty(Element.prototype, 'attributes', {
		configurable: true,
		get() {
			return Array.from(attributes.get!.call(this) as NamedNodeMap);
		},
	});
	try {
		(element as HTMLElement).click();
	} finally {
		Object.defineProperty(Element.prototype, 'attributes', attributes);
	}
}

function sentEvents(): Array<{ event: string; properties: Record<string, unknown> }> {
	return requests.flatMap((request) => {
		const data = request.data;
		if (Array.isArray(data)) return data;
		return data && typeof data === 'object' && 'event' in data ? [data as never] : [];
	});
}

function expectNoSentinel() {
	const everything = JSON.stringify(requests);
	for (const sentinel of SENTINELS) expect(everything).not.toContain(sentinel);
}

beforeEach(() => {
	requests = [];
	// happy-dom reports itself as automated, which the SDK treats as a bot.
	Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => false });
	window.localStorage.clear();
	window.sessionStorage.clear();
	document.body.innerHTML = '';
	Object.defineProperty(document, 'referrer', {
		configurable: true,
		value: 'https://webmail.example.org/read/PATH_SENTINEL?m=QUERY_SENTINEL',
	});
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('{}'))
	);
});

afterEach(() => {
	// An earlier test's client still listens for page-leave on this window.
	current?.opt_out_capturing();
	current = null;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('posthog plugin — URL privacy with the real SDK', () => {
	it('sends route patterns and never the query, fragment or ids of a page', async () => {
		const router = makeRouter();
		await router.push('/dashboard/postbox/PATH_SENTINEL?q=QUERY_SENTINEL#FRAGMENT_SENTINEL');
		const { plugin, flag, posthog } = await loadPlugin(router);
		const { provide } = plugin();
		flag.value = true;
		await settle();
		expect(provide.posthog.value).toBe(posthog);

		// Initial load: the first event carries the entry URL and the referrer.
		posthog.capture('owlat_probe', {
			link: 'https://app.invalid/x?QUERY_SENTINEL',
			path: '/share?token=QUERY_SENTINEL',
		});

		// SPA navigation pageview.
		await router.push(
			'/dashboard/postbox/inbox/PATH_SENTINEL?view=QUERY_SENTINEL#FRAGMENT_SENTINEL'
		);
		await settle();

		// A performance sample.
		const telemetry = await import('~/lib/perfTelemetry');
		telemetry.reportPerf('owlat_boot_shell_ms', { duration_ms: 12 });

		// An autocaptured click on a token-bearing link.
		document.body.innerHTML = `<a id="l" class="row" href="/share?token=QUERY_SENTINEL#FRAGMENT_SENTINEL">
			<span>Subject PATH_SENTINEL</span></a>
			<a id="m" href="${window.location.origin}/dashboard/postbox/PATH_SENTINEL?q=QUERY_SENTINEL">x</a>`;
		click(document.getElementById('l')!);
		click(document.getElementById('m')!);

		// An exception whose message names a URL.
		posthog.capture('$exception', {
			$exception_message: `Failed to load ${window.location.origin}/share?token=QUERY_SENTINEL`,
		});

		// Page leave, and everything queued goes out.
		flush();
		await settle();

		const events = sentEvents();
		const names = events.map((e) => e.event);
		expect(names).toEqual(
			expect.arrayContaining([
				'owlat_probe',
				'$pageview',
				'owlat_boot_shell_ms',
				'$autocapture',
				'$exception',
				'$pageleave',
			])
		);
		expectNoSentinel();

		const pageview = events.find((e) => e.event === '$pageview')!;
		expect(pageview.properties['route']).toBe('dashboard-postbox-folder-messageId');
		expect(pageview.properties['$current_url']).toBe(
			`${window.location.origin}/dashboard/postbox/:folder/:messageId`
		);
		expect(pageview.properties['$pathname']).toBe('/dashboard/postbox/:folder/:messageId');
		expect(pageview.properties['$referrer']).toBe('https://webmail.example.org');

		const autocaptured = events.find((e) => e.event === '$autocapture')!;
		expect(String(autocaptured.properties['$elements_chain'])).toContain('href="/share"');
		// No flags request: it would carry the stored entry URL outside before_send.
		expect(requests.some((r) => r.url.includes('/flags'))).toBe(false);
	});

	it('does not start the SDK on a credential page, and starts it on the next page', async () => {
		const router = makeRouter();
		await router.push('/auth/reset-password?token=QUERY_SENTINEL#FRAGMENT_SENTINEL');
		const { plugin, flag, posthog } = await loadPlugin(router);
		const init = vi.spyOn(posthog, 'init');
		const { provide } = plugin();
		flag.value = true;
		await settle();

		expect(init).not.toHaveBeenCalled();
		expect(provide.posthog.value).toBeNull();

		await router.push('/auth/login');
		await settle();
		expect(init).toHaveBeenCalledOnce();
		expect(provide.posthog.value).toBe(posthog);

		posthog.capture('owlat_probe');
		flush();
		await settle();
		expect(sentEvents().map((e) => e.event)).toContain('owlat_probe');
		expectNoSentinel();
	});

	it('drops every event while an already running SDK is on a credential page', async () => {
		const router = makeRouter();
		await router.push('/dashboard');
		const { plugin, flag, posthog } = await loadPlugin(router);
		plugin();
		flag.value = true;
		await settle();

		await router.push('/share?token=QUERY_SENTINEL');
		await settle();
		posthog.capture('owlat_probe', { note: 'on the share page' });
		flush();
		await settle();

		expect(sentEvents().map((e) => e.event)).not.toContain('owlat_probe');
		expect(sentEvents().map((e) => e.event)).not.toContain('$pageview');
		expectNoSentinel();
	});
});
