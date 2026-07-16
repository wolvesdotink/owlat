import { describe, expect, it } from 'vitest';
import {
	parsePluginId,
	PLUGIN_IMPORT_PROVIDER_CAPABILITY,
	pluginImportProviderKind,
	validatePluginManifest,
	type PluginImportProviderDefinition,
	type PluginManifestIssue,
} from '../index';

function validProvider(): PluginImportProviderDefinition {
	return {
		id: 'hubspot',
		label: 'HubSpot',
		module: { exportPath: './providers/hubspot' },
		signature: {
			header: 'x-hubspot-signature',
			algorithm: 'hmac-sha256',
			encoding: 'hex',
			secretEnvVar: 'HUBSPOT_WEBHOOK_SECRET',
		},
		attestSource: 'hubspot',
	};
}

function base(providers: readonly unknown[] = [validProvider()]): Record<string, unknown> {
	return {
		id: 'crm-pack',
		version: '1.0.0',
		capabilities: [PLUGIN_IMPORT_PROVIDER_CAPABILITY],
		flag: { default: false },
		contributes: { importProviders: providers },
	};
}

function issuesFor(value: unknown): readonly PluginManifestIssue[] {
	const result = validatePluginManifest(value);
	return result.ok ? [] : result.issues;
}

describe('plugin import provider contributions', () => {
	it('namespaces every provider under its owning plugin id', () => {
		expect(pluginImportProviderKind(parsePluginId('crm-pack'), 'hubspot')).toBe(
			'plugin.crm-pack.hubspot'
		);
	});

	it('accepts a well-formed import-provider manifest', () => {
		expect(validatePluginManifest(base()).ok).toBe(true);
	});

	it('requires the imports:provide capability when providers are contributed', () => {
		expect(
			issuesFor(base()).length === 0 &&
				issuesFor({ ...base(), capabilities: [] }).some((i) => i.path === '$.capabilities')
		).toBe(true);
	});

	it('requires the inbound signature verification contract', () => {
		const provider = validProvider();
		delete (provider as { signature?: unknown }).signature;
		const issues = issuesFor(base([provider]));
		expect(
			issues.some(
				(issue) =>
					issue.path === '$.contributes.importProviders[0].signature' && issue.code === 'missing'
			)
		).toBe(true);
	});

	it.each([
		['bad header', { header: 'X_Bad Header' }, '$.contributes.importProviders[0].signature.header'],
		[
			'unknown algorithm',
			{ algorithm: 'md5' },
			'$.contributes.importProviders[0].signature.algorithm',
		],
		[
			'unknown encoding',
			{ encoding: 'base32' },
			'$.contributes.importProviders[0].signature.encoding',
		],
		[
			'bad secret env var',
			{ secretEnvVar: 'lower_case' },
			'$.contributes.importProviders[0].signature.secretEnvVar',
		],
	] as const)('rejects a signature contract with %s', (_label, override, path) => {
		const provider = validProvider();
		const issues = issuesFor(
			base([{ ...provider, signature: { ...provider.signature, ...override } }])
		);
		expect(issues.some((issue) => issue.path === path)).toBe(true);
	});

	it('rejects an unsafe module export path', () => {
		const provider = validProvider();
		const issues = issuesFor(base([{ ...provider, module: { exportPath: '../escape' } }]));
		expect(
			issues.some((issue) => issue.path === '$.contributes.importProviders[0].module.exportPath')
		).toBe(true);
	});

	it('rejects duplicate provider ids', () => {
		const issues = issuesFor(base([validProvider(), validProvider()]));
		expect(issues.some((issue) => issue.code === 'duplicate')).toBe(true);
	});
});
