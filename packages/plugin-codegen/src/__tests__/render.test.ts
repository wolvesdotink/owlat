import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { composeBundledPlugins, type BundledPlugin } from '@owlat/plugin-host';
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
	});
});
