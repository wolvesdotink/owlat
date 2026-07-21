import { describe, expect, it } from 'vitest';
import type { PluginPackageName } from '@owlat/plugin-host';
import { addPackage, parsePackageArgument, removePackage, serializePluginsConfig } from '../config';
import { PluginCliError } from '../errors';

function names(values: readonly string[]): readonly PluginPackageName[] {
	return values as readonly PluginPackageName[];
}

describe('serializePluginsConfig', () => {
	it('renders the canonical empty config that parsePluginsConfig round-trips', () => {
		expect(serializePluginsConfig([])).toBe(
			`import type { PluginsConfig } from '@owlat/plugin-codegen';\n\n` +
				`export default {\n\tbundledPluginPackages: [],\n} satisfies PluginsConfig;\n`
		);
	});

	it('keeps a short package list inline', () => {
		expect(serializePluginsConfig(names(['@acme/a', 'zebra']))).toContain(
			"bundledPluginPackages: ['@acme/a', 'zebra'],"
		);
	});

	it('wraps a list that would exceed the 100-column print width one entry per line', () => {
		const long = names([
			'@acme/plugin-with-a-fairly-long-name',
			'@acme/another-long-plugin-name-here',
			'@acme/third-plugin-name-padding',
		]);
		const source = serializePluginsConfig(long);
		expect(source).toContain('\tbundledPluginPackages: [\n');
		expect(source).toContain("\t\t'@acme/plugin-with-a-fairly-long-name',\n");
		expect(source).toContain('\t],\n');
	});
});

describe('addPackage', () => {
	it('appends a new package and reports the change', () => {
		expect(addPackage(names(['a']), 'b' as PluginPackageName)).toEqual({
			packages: ['a', 'b'],
			changed: true,
		});
	});

	it('is idempotent for an already-listed package', () => {
		expect(addPackage(names(['a', 'b']), 'b' as PluginPackageName)).toEqual({
			packages: ['a', 'b'],
			changed: false,
		});
	});
});

describe('removePackage', () => {
	it('drops a listed package and reports the change', () => {
		expect(removePackage(names(['a', 'b']), 'a' as PluginPackageName)).toEqual({
			packages: ['b'],
			changed: true,
		});
	});

	it('is a no-op for an absent package', () => {
		expect(removePackage(names(['a']), 'b' as PluginPackageName)).toEqual({
			packages: ['a'],
			changed: false,
		});
	});
});

describe('parsePackageArgument', () => {
	it('accepts a valid scoped npm package name', () => {
		expect(parsePackageArgument('@acme/plugin')).toBe('@acme/plugin');
	});

	it('rejects a package name with a subpath as a PluginCliError', () => {
		expect(() => parsePackageArgument('@acme/plugin/sub')).toThrow(PluginCliError);
	});

	it('rejects an uppercase or empty name', () => {
		expect(() => parsePackageArgument('Plugin')).toThrow(PluginCliError);
		expect(() => parsePackageArgument('')).toThrow(PluginCliError);
	});
});
