import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick, ref, type ShallowRef } from 'vue';
import type PostHog from 'posthog-js';

/**
 * `analytics.posthog` is the gate the docs promise and the reason a
 * privacy-positioned self-host ships the flag off by default: a configured key
 * must not, on its own, start shipping behaviour to a third party. These cases
 * pin the two edges (never initialising while the flag is off, tearing the
 * identity down when it flips off) rather than the plugin's internals.
 */

const posthogStub = {
	init: vi.fn(),
	capture: vi.fn(),
	opt_in_capturing: vi.fn(),
	opt_out_capturing: vi.fn(),
	reset: vi.fn(),
	debug: vi.fn(),
};

vi.mock('posthog-js', () => ({ default: posthogStub }));

type Plugin = () => { provide: { posthog: ShallowRef<typeof PostHog | null> } };

const afterEach_ = vi.fn();

/**
 * Each case gets its OWN flag ref: the plugin's watcher lives for the life of
 * the app and nothing stops it, so a shared ref would let an earlier case's
 * plugin instance re-initialise when a later case flips the flag.
 */
async function loadPlugin(options?: { apiKey?: string }) {
	const flag = ref(false);
	vi.stubGlobal('defineNuxtPlugin', (def: unknown) => def);
	vi.stubGlobal('useRuntimeConfig', () => ({
		public: {
			posthogApiKey: options?.apiKey ?? 'phc_test',
			posthogHost: 'https://posthog.example',
		},
	}));
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (key: string) => key === 'analytics.posthog' && flag.value,
	}));
	vi.stubGlobal('useRouter', () => ({ afterEach: afterEach_ }));
	vi.resetModules();
	const mod = await import('../posthog.client');
	return { plugin: mod.default as unknown as Plugin, flag };
}

/** Let the flag watcher run and its dynamic `import('posthog-js')` settle. */
async function settle() {
	await nextTick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await nextTick();
}

describe('posthog plugin — analytics.posthog gate', () => {
	beforeEach(() => {
		for (const fn of Object.values(posthogStub)) fn.mockClear();
		afterEach_.mockClear();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('does not initialise while the flag is off, even with a key configured', async () => {
		const { plugin } = await loadPlugin();
		const { provide } = plugin();
		await settle();

		expect(posthogStub.init).not.toHaveBeenCalled();
		expect(provide.posthog.value).toBeNull();
	});

	it('initialises once the flag resolves on, and opts capturing back in', async () => {
		const { plugin, flag } = await loadPlugin();
		const { provide } = plugin();
		await settle();

		flag.value = true;
		await settle();

		expect(posthogStub.init).toHaveBeenCalledTimes(1);
		expect(posthogStub.init.mock.calls[0]?.[0]).toBe('phc_test');
		// A persisted opt-out from a previous session must not outlive re-enabling.
		expect(posthogStub.opt_in_capturing).toHaveBeenCalled();
		expect(provide.posthog.value).toBe(posthogStub);
	});

	it('stops capturing and drops the identity when the flag flips off', async () => {
		const { plugin, flag } = await loadPlugin();
		const { provide } = plugin();
		flag.value = true;
		await settle();

		flag.value = false;
		await settle();

		expect(posthogStub.opt_out_capturing).toHaveBeenCalled();
		expect(posthogStub.reset).toHaveBeenCalled();
		expect(provide.posthog.value).toBeNull();
	});

	it('never initialises without a key, whatever the flag says', async () => {
		const { plugin, flag } = await loadPlugin({ apiKey: '' });
		const { provide } = plugin();
		flag.value = true;
		await settle();

		expect(posthogStub.init).not.toHaveBeenCalled();
		expect(provide.posthog.value).toBeNull();
	});
});
