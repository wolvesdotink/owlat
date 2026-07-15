import { describe, expect, it } from 'vitest';
import { composeBundledPlugins } from '@owlat/plugin-host';
import { renderPluginComposition } from '../render';

describe('composition rendering', () => {
	it('renders deterministic Convex and Nuxt imports in manifest-id order', () => {
		const first = composeBundledPlugins([
			{
				packageName: 'zebra-plugin',
				manifest: { id: 'zebra', version: '1.0.0', capabilities: [] },
			},
			{
				packageName: '@acme/alpha-plugin',
				manifest: { id: 'alpha', version: '1.0.0', capabilities: [] },
			},
		]);
		const second = composeBundledPlugins([...first].reverse());

		const rendered = renderPluginComposition(first);
		expect(renderPluginComposition(second)).toEqual(rendered);
		expect(rendered.convex).toContain(
			"import bundledPluginManifest0 from '@acme/alpha-plugin';\nimport bundledPluginManifest1 from 'zebra-plugin';"
		);
		expect(rendered.convex).toContain(
			"{ packageName: '@acme/alpha-plugin', manifest: bundledPluginManifest0 }"
		);
		expect(rendered.nuxt).toContain("name: 'owlat:bundled-plugin-composition'");
	});

	it('keeps a zero-plugin repository as an explicit no-op composition', () => {
		const rendered = renderPluginComposition([]);
		expect(rendered.convex).toContain('composeBundledPlugins([]);');
		expect(rendered.convex).not.toContain('bundledPluginManifest0');
		expect(rendered.nuxt).toContain('void bundledPluginComposition;');
	});
});
