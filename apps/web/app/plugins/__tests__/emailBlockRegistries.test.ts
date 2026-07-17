import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

/**
 * Unit-test the boot plugin's wiring: it must run the host's email-block
 * composition exactly once at module evaluation, guarded so an already-frozen
 * set of registries (repeat SSR import / dev HMR) is not composed again. The
 * real freeze semantics are covered by the @owlat/email-builder package tests;
 * here the host is mocked so the plugin's own logic is what is under test.
 */
const hoisted = vi.hoisted(() => ({
	state: { frozen: false },
	compose: vi.fn((_contributions: readonly unknown[]) => [] as readonly unknown[]),
}));

vi.mock('@owlat/email-builder', () => ({
	areEmailBlockRegistriesFrozen: () => hoisted.state.frozen,
	composeHostedEmailBlocks: (contributions: readonly unknown[]) => {
		hoisted.state.frozen = true;
		return hoisted.compose(contributions);
	},
}));

async function loadPlugin() {
	vi.resetModules();
	// `defineNuxtPlugin` is a Nuxt global not present under vitest.
	vi.stubGlobal('defineNuxtPlugin', (def: unknown) => def);
	return (await import('../plugin-email-blocks')).default;
}

describe('email-block registries host boot plugin', () => {
	beforeEach(() => {
		hoisted.state.frozen = false;
		hoisted.compose.mockClear();
	});
	afterEach(() => vi.unstubAllGlobals());

	it('composes the host email blocks once at boot with an empty contribution list', async () => {
		await loadPlugin();
		expect(hoisted.compose).toHaveBeenCalledTimes(1);
		expect(hoisted.compose).toHaveBeenCalledWith([]);
	});

	it('skips composition when the registries are already frozen', async () => {
		hoisted.state.frozen = true;
		await loadPlugin();
		expect(hoisted.compose).not.toHaveBeenCalled();
	});

	it('exposes a valid Nuxt plugin object', async () => {
		const plugin = await loadPlugin();
		expect(plugin).toMatchObject({ name: 'owlat:email-block-registries' });
	});
});
