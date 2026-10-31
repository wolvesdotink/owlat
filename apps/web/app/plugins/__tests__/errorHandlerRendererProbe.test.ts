import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';

/**
 * The desktop launch smoke test passes when the welcome page mounts with no
 * renderer error. This plugin catches Vue component errors without rethrowing,
 * so the probe only learns of one through the event the plugin announces. The
 * real plugin and the real probe from the desktop shell (injected into the
 * fixture build's webview) run against a page whose child component throws in
 * setup while the address field still renders.
 */

const PROBE = readFileSync(
	join(import.meta.dirname, '../../../../desktop/src-tauri/src/e2e-probe.js'),
	'utf8'
);

type ErrorPlugin = (nuxtApp: unknown) => void;
type Hook = (error: unknown) => void;

const showToast = vi.fn();
let sent: Array<Record<string, unknown>>;
let hooks: Map<string, Hook>;
let app: App | null;
let nuxtRoot: HTMLElement;

async function loadPlugin(): Promise<ErrorPlugin> {
	vi.stubGlobal('defineNuxtPlugin', (def: unknown) => def);
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.resetModules();
	const mod = await import('../error-handler.client');
	return mod.default as unknown as ErrorPlugin;
}

async function installPage(rootComponent: Parameters<typeof createApp>[0]) {
	app = createApp(rootComponent);
	const plugin = await loadPlugin();
	plugin({
		vueApp: app,
		$posthog: null,
		hook: (name: string, fn: Hook) => hooks.set(name, fn),
	});
	return app;
}

/** MutationObserver callbacks are microtasks; let them run. */
async function settle() {
	await nextTick();
	await Promise.resolve();
	await Promise.resolve();
}

const probeCleanups: Array<() => void> = [];

/**
 * A fresh probe per case, as the shell injects one per page load. Its window
 * listeners and observer are tracked so the next case starts without them.
 */
function injectProbe() {
	const listen = vi.spyOn(window, 'addEventListener');
	const Observer = window.MutationObserver;
	class TrackedObserver extends Observer {
		constructor(callback: MutationCallback) {
			super(callback);
			probeCleanups.push(() => this.disconnect());
		}
	}
	vi.stubGlobal('MutationObserver', TrackedObserver);
	try {
		new Function(PROBE)();
	} finally {
		for (const [type, listener, options] of listen.mock.calls) {
			probeCleanups.push(() => window.removeEventListener(type, listener, options));
		}
		listen.mockRestore();
		vi.stubGlobal('MutationObserver', Observer);
	}
}

const rendererErrors = () => sent.filter((payload) => payload['event'] === 'renderer-error');

beforeEach(() => {
	sent = [];
	hooks = new Map();
	app = null;
	showToast.mockClear();
	window.history.replaceState({}, '', '/desktop/welcome');
	document.title = 'Welcome';
	nuxtRoot = document.createElement('div');
	nuxtRoot.id = '__nuxt';
	document.body.append(nuxtRoot);
	vi.stubGlobal('__TAURI_INTERNALS__', {
		invoke: (cmd: string, args: { event: string; payload: Record<string, unknown> }) => {
			if (cmd === 'plugin:event|emit' && args.event === 'owlat-e2e') sent.push(args.payload);
			return Promise.resolve();
		},
	});
	injectProbe();
});

afterEach(() => {
	app?.unmount();
	for (const remove of probeCleanups.splice(0)) remove();
	vi.unstubAllGlobals();
	nuxtRoot.remove();
});

describe('error handler plugin and the desktop renderer probe', () => {
	it('reports a child that throws in setup even though the page still mounts', async () => {
		const Broken = defineComponent({
			name: 'BrokenWelcomePanel',
			setup() {
				throw new Error('panel setup failed');
			},
		});
		const Welcome = defineComponent({
			render: () => h('main', [h('input', { name: 'address' }), h(Broken)]),
		});

		(await installPage(Welcome)).mount('#__nuxt');
		await settle();

		expect(sent.some((payload) => payload['event'] === 'mounted')).toBe(true);
		expect(rendererErrors()).toEqual([
			{ event: 'renderer-error', kind: 'vue', detail: 'vue:setup function: panel setup failed' },
		]);
		// The user-facing behaviour is unchanged.
		expect(showToast).toHaveBeenCalledOnce();
	});

	it('reports a component error after mount', async () => {
		const Welcome = defineComponent({
			render: () =>
				h('main', [
					h('input', { name: 'address' }),
					h(
						'button',
						{
							onClick: () => {
								throw new Error('click handler failed');
							},
						},
						'Connect'
					),
				]),
		});

		(await installPage(Welcome)).mount('#__nuxt');
		await settle();
		expect(rendererErrors()).toEqual([]);

		document.querySelector('button')!.click();
		await settle();

		expect(rendererErrors()).toEqual([
			{
				event: 'renderer-error',
				kind: 'vue',
				detail: expect.stringContaining('click handler failed'),
			},
		]);
	});

	it('reports a Nuxt app error, such as a plugin that threw', async () => {
		await installPage(defineComponent({ render: () => h('input') }));

		hooks.get('app:error')!(new Error('plugin failed'));
		await settle();

		expect(rendererErrors()).toEqual([
			{ event: 'renderer-error', kind: 'vue', detail: 'nuxt:app: plugin failed' },
		]);
	});

	it('reports nothing for a page that mounts cleanly', async () => {
		(await installPage(defineComponent({ render: () => h('input') }))).mount('#__nuxt');
		await settle();

		expect(sent).toEqual([{ event: 'mounted', path: '/desktop/welcome', title: 'Welcome' }]);
	});
});
