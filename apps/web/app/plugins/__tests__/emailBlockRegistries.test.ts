import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

/**
 * Unit-test the boot plugin's wiring: it must arm the email-block registries'
 * freeze-on-first-read latch at module evaluation, and it must do so without
 * importing the email builder or the renderer barrel, which would put the
 * editor registry, SortableJS, the renderer and sanitize-html back into the
 * boot bundle. The freeze semantics themselves are covered by the
 * @owlat/email-builder package tests; here the latch is mocked so the plugin's
 * own logic is what is under test.
 */
const hoisted = vi.hoisted(() => ({ arm: vi.fn() }));

vi.mock('@owlat/email-renderer/registry-latch', () => ({
	armEmailBlockRegistryFreeze: hoisted.arm,
}));

async function loadPlugin() {
	vi.resetModules();
	// `defineNuxtPlugin` is a Nuxt global not present under vitest.
	vi.stubGlobal('defineNuxtPlugin', (def: unknown) => def);
	return (await import('../plugin-email-blocks')).default;
}

describe('email-block registries host boot plugin', () => {
	beforeEach(() => hoisted.arm.mockClear());
	afterEach(() => vi.unstubAllGlobals());

	it('arms the freeze-on-first-read latch once at boot', async () => {
		await loadPlugin();
		expect(hoisted.arm).toHaveBeenCalledTimes(1);
	});

	it('exposes a valid Nuxt plugin object', async () => {
		const plugin = await loadPlugin();
		expect(plugin).toMatchObject({ name: 'owlat:email-block-registries' });
	});

	it('imports only the leaf latch module, not the email packages', () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(resolve(here, '../plugin-email-blocks.ts'), 'utf8');
		const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
		expect(specifiers).toEqual(['@owlat/email-renderer/registry-latch']);
	});
});
