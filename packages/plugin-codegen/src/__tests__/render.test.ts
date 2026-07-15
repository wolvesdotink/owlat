import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { composeBundledPlugins, type BundledPlugin } from '@owlat/plugin-host';
import { convexComponentNamespace, renderPluginComposition } from '../render';

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
			'import bundledPluginManifest0 from "@acme/alpha-plugin";\nimport bundledPluginManifest1 from "zebra-plugin";'
		);
		expect(rendered.convex).toContain(
			'{ packageName: "@acme/alpha-plugin", manifest: bundledPluginManifest0 }'
		);
		expect(rendered.nuxt).toContain("name: 'owlat:bundled-plugin-composition'");
		const parsed = ts.createSourceFile(
			'plugins.generated.ts',
			rendered.convex,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS
		);
		expect(
			(parsed as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] })
				.parseDiagnostics
		).toEqual([]);
	});

	it.each([
		`safe-package';\nconsole.error('INJECTED');//`,
		'safe-package\\escape',
		'safe-package\rnext',
		'safe-package\nnext',
		'safe-package\u2028next',
		'safe-package\u2029next',
		'safe-package${template}',
	])('rejects an unvalidated generated module specifier: %j', (packageName) => {
		const maliciousPlugin = {
			packageName,
			manifest: { id: 'safe', version: '1.0.0', capabilities: [] },
		} as unknown as BundledPlugin;

		expect(() => renderPluginComposition([maliciousPlugin])).toThrow(
			'Invalid bundled plugin package name'
		);
	});

	it('keeps a zero-plugin repository as an explicit no-op composition', () => {
		const rendered = renderPluginComposition([]);
		expect(rendered.convex).toContain('composeBundledPlugins([]);');
		expect(rendered.convex).not.toContain('bundledPluginManifest0');
		expect(rendered.nuxt).toContain('void bundledPluginComposition;');
		expect(rendered.components).toContain('void app;');
	});

	it('statically imports and installs components in deterministic isolated namespaces', () => {
		const plugins = composeBundledPlugins([
			{
				packageName: 'zebra-plugin',
				manifest: {
					id: 'zebra-lab',
					version: '1.0.0',
					capabilities: [],
					component: { exportPath: './convex/convex.config' },
				},
			},
			{
				packageName: '@acme/alpha-plugin',
				manifest: {
					id: 'alpha',
					version: '1.0.0',
					capabilities: [],
					component: { exportPath: './backend/component' },
				},
			},
		]);
		const output = renderPluginComposition(plugins).components;

		expect(output).toContain('from "@acme/alpha-plugin/backend/component"');
		expect(output).toContain('{ name: "plugin_alpha" }');
		expect(output).toContain('from "zebra-plugin/convex/convex.config"');
		expect(output).toContain('{ name: "plugin_zebra_lab" }');
		expect(output.indexOf('plugin_alpha')).toBeLessThan(output.indexOf('plugin_zebra_lab'));
	});

	it('maps every valid id injectively into a bounded Convex identifier', () => {
		const ids = ['a', 'a-b', 'ab', 'a-b-c', `a${'b'.repeat(63)}`];
		const names = ids.map(convexComponentNamespace);

		expect(new Set(names).size).toBe(ids.length);
		for (const name of names) {
			expect(name).toMatch(/^[A-Za-z0-9_]+$/);
			expect(name.length).toBeLessThanOrEqual(128);
		}
	});
});
