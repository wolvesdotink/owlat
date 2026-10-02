import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * The service-worker plugin is split in two so the entry chunk only carries
 * the boot decision: `service-worker.client.ts` decides, and on `load` it
 * imports `~/lib/serviceWorkerControl`, which registers, tears down (keeping a
 * push-carrying worker alive as push-only) and routes notification clicks.
 * These cases run the plugin against a fake `navigator.serviceWorker` and pin
 * both halves, plus the import shape that keeps the runtime out of the entry.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pluginSource = readFileSync(resolve(here, '..', 'service-worker.client.ts'), 'utf8');

const ORIGIN = 'https://mail.example.com';

interface FakeRegistration {
	active: { scriptURL: string };
	pushManager: { getSubscription: () => Promise<object | null> };
	unregister: ReturnType<typeof vi.fn>;
}

function registration(path: string, subscribed: boolean): FakeRegistration {
	return {
		active: { scriptURL: `${ORIGIN}${path}` },
		pushManager: { getSubscription: async () => (subscribed ? {} : null) },
		unregister: vi.fn(async () => true),
	};
}

let publicConfig: Record<string, unknown>;
let worker: EventTarget & {
	register: ReturnType<typeof vi.fn>;
	getRegistrations: ReturnType<typeof vi.fn>;
};
let navigateTo: ReturnType<typeof vi.fn>;
let deletedCaches: string[];

/** Globals set for one case and restored after it (keeps the setup file's stubs). */
const restores: Array<() => void> = [];
function stub(target: object, name: string, value: unknown) {
	const descriptor = Object.getOwnPropertyDescriptor(target, name);
	Object.defineProperty(target, name, { value, configurable: true, writable: true });
	restores.push(() => {
		if (descriptor) Object.defineProperty(target, name, descriptor);
		else delete (target as Record<string, unknown>)[name];
	});
}

async function flush() {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function runPlugin() {
	vi.resetModules();
	const plugin = (await import('../service-worker.client')).default as unknown as () => void;
	plugin();
}

beforeEach(() => {
	publicConfig = { isDesktopBuild: false, offlineShell: true };
	worker = Object.assign(new EventTarget(), {
		register: vi.fn(async () => ({})),
		getRegistrations: vi.fn(async () => [] as FakeRegistration[]),
	});
	navigateTo = vi.fn(async () => {});
	deletedCaches = [];
	stub(navigator, 'serviceWorker', worker);
	stub(document, 'readyState', 'complete');
	stub(globalThis, 'useRuntimeConfig', () => ({ public: publicConfig }));
	stub(globalThis, 'navigateTo', navigateTo);
	stub(globalThis, 'caches', {
		keys: async () => ['owlat-shell-v1', 'someone-else'],
		delete: async (name: string) => {
			deletedCaches.push(name);
			return true;
		},
	});
});

afterEach(() => {
	while (restores.length > 0) restores.pop()?.();
});

describe('service-worker plugin', () => {
	it('statically imports only the decision; the runtime is a lazy chunk', () => {
		// Rollup keeps a whole module in the entry chunk once the entry imports
		// any export from it. One static import, of the decision module alone.
		const staticImports = [...pluginSource.matchAll(/^import\s.+\sfrom\s+'([^']+)'/gm)].map(
			(match) => match[1]
		);
		expect(staticImports).toEqual(['~/utils/serviceWorkerAction']);
		expect(pluginSource).toContain("import('~/lib/serviceWorkerControl')");
	});

	it('registers the full shell, but only once the page has loaded', async () => {
		stub(document, 'readyState', 'interactive');
		await runPlugin();
		await flush();
		expect(worker.register).not.toHaveBeenCalled();

		window.dispatchEvent(new Event('load'));
		await vi.waitFor(() => expect(worker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' }));
		expect(worker.getRegistrations).not.toHaveBeenCalled();
	});

	it('tears down behind the kill switch, keeping a push-carrying worker as push-only', async () => {
		publicConfig.offlineShell = false;
		const plain = registration('/sw.js', false);
		const pushing = registration('/sw.js', true);
		const foreign = registration('/vendor/sw.js', false);
		worker.getRegistrations.mockResolvedValue([plain, pushing, foreign]);

		await runPlugin();
		await vi.waitFor(() => expect(deletedCaches).toEqual(['owlat-shell-v1']));

		expect(plain.unregister).toHaveBeenCalledOnce();
		expect(pushing.unregister).not.toHaveBeenCalled();
		expect(worker.register).toHaveBeenCalledExactlyOnceWith('/sw.js?shell=off', { scope: '/' });
		expect(foreign.unregister).not.toHaveBeenCalled();
	});

	it('routes a notification click in-app, and nothing else', async () => {
		await runPlugin();
		await vi.waitFor(() => expect(worker.register).toHaveBeenCalled());

		const post = (data: unknown) => worker.dispatchEvent(new MessageEvent('message', { data }));
		post({ type: 'owlat:navigate', path: '//evil.example.com' });
		post({ type: 'other', path: '/dashboard' });
		expect(navigateTo).not.toHaveBeenCalled();

		post({ type: 'owlat:navigate', path: '/dashboard/chat/r1' });
		expect(navigateTo).toHaveBeenCalledExactlyOnceWith('/dashboard/chat/r1');
	});

	it('does nothing where service workers are unsupported', async () => {
		stub(globalThis, 'navigator', { userAgent: 'test' });
		// Not loaded yet, so a plugin that went ahead would wait for `load`.
		stub(document, 'readyState', 'interactive');
		const addEventListener = vi.spyOn(window, 'addEventListener');

		await runPlugin();
		await flush();

		expect(addEventListener).not.toHaveBeenCalledWith('load', expect.anything(), expect.anything());
		expect(worker.register).not.toHaveBeenCalled();
		addEventListener.mockRestore();
	});
});
