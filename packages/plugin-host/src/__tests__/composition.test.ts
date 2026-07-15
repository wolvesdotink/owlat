import { describe, expect, it } from 'vitest';
import { composeBundledPlugins, PluginCompositionError } from '../composition';

function manifest(id: string, capabilities: readonly string[] = []) {
	return { id, version: '1.0.0', capabilities };
}

describe('bundled plugin composition', () => {
	it('validates, freezes, and orders manifests by id independent of config order', () => {
		const composition = composeBundledPlugins([
			{ packageName: '@example/zebra', manifest: manifest('zebra') },
			{ packageName: '@example/alpha', manifest: manifest('alpha', ['mail:read']) },
		]);

		expect(composition.map((plugin) => plugin.manifest.id)).toEqual(['alpha', 'zebra']);
		expect(composition[0]?.manifest.capabilities).toEqual(['mail:read']);
		expect(Object.isFrozen(composition)).toBe(true);
		expect(Object.isFrozen(composition[0])).toBe(true);
		expect(Object.isFrozen(composition[0]?.manifest)).toBe(true);
	});

	it('rejects duplicate package entries', () => {
		expect(() =>
			composeBundledPlugins([
				{ packageName: '@example/mail', manifest: manifest('mail-one') },
				{ packageName: '@example/mail', manifest: manifest('mail-two') },
			])
		).toThrow(expect.objectContaining({ code: 'duplicate_package', value: '@example/mail' }));
	});

	it('rejects duplicate manifest ids across different packages', () => {
		expect(() =>
			composeBundledPlugins([
				{ packageName: '@example/mail-one', manifest: manifest('mail') },
				{ packageName: '@example/mail-two', manifest: manifest('mail') },
			])
		).toThrow(expect.objectContaining({ code: 'duplicate_manifest_id', value: 'mail' }));
	});

	it('rejects invalid manifests before exposing a composition', () => {
		expect(() =>
			composeBundledPlugins([
				{ packageName: '@example/invalid', manifest: { ...manifest('Invalid'), unknown: true } },
			])
		).toThrow('Invalid plugin manifest');
	});

	it('bounds composition work', () => {
		const sources = Array.from({ length: 129 }, (_, index) => ({
			packageName: `example-${index}`,
			manifest: manifest(`example-${index}`),
		}));

		expect(() => composeBundledPlugins(sources)).toThrow(
			expect.objectContaining<Partial<PluginCompositionError>>({ code: 'too_many_plugins' })
		);
	});
});
