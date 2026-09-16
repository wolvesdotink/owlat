import { describe, it, expect } from 'vitest';
import type { FeatureFlagDefinition } from '@owlat/shared/featureFlags';
import {
	enableTimeMissingEnvVars,
	flagsNeedingConfig,
	missingPluginEnvironmentVariables,
} from '../featureConfig';

describe('flagsNeedingConfig', () => {
	it('badges an enabled flag that is missing configuration', () => {
		const result = flagsNeedingConfig({ ai: true }, { ai: ['LLM_PROVIDER', 'LLM_API_KEY'] });
		expect(result.has('ai')).toBe(true);
	});

	it('does not badge a disabled flag even if it is missing configuration', () => {
		const result = flagsNeedingConfig({ ai: false }, { ai: ['LLM_PROVIDER'] });
		expect(result.has('ai')).toBe(false);
	});

	it('does not badge an enabled flag with no missing requirements', () => {
		const result = flagsNeedingConfig(
			{ ai: true, campaigns: true },
			{ campaigns: ['A configured delivery provider'] }
		);
		expect(result.has('ai')).toBe(false);
		expect(result.has('campaigns')).toBe(true);
	});

	it('badges sending flags missing a delivery provider', () => {
		const result = flagsNeedingConfig(
			{ transactional: true },
			{ transactional: ['A configured delivery provider'] }
		);
		expect(result.has('transactional')).toBe(true);
	});

	it('returns an empty set while the status map is still loading', () => {
		expect(flagsNeedingConfig({ ai: true }, undefined).size).toBe(0);
		expect(flagsNeedingConfig({ ai: true }, null).size).toBe(0);
	});

	it('ignores entries with an empty missing-requirements list', () => {
		const result = flagsNeedingConfig({ ai: true }, { ai: [] });
		expect(result.has('ai')).toBe(false);
	});
});

describe('plugin feature configuration', () => {
	const definition = {
		key: 'plugin.policy-pack',
		category: 'plugins',
		label: 'Policy Pack',
		description: 'Bundled plugin from @example/policy-pack.',
		default: false,
		requiredEnvVars: ['POLICY_TOKEN', 'POLICY_URL'],
		requiredCapabilities: ['mail:read'],
		pluginPackageName: '@example/policy-pack',
	} satisfies FeatureFlagDefinition;

	it('separates missing env requirements from capability approval gaps', () => {
		expect(
			missingPluginEnvironmentVariables(definition, {
				[definition.key]: ['POLICY_TOKEN', 'Grant: mail:read'],
			})
		).toEqual(['POLICY_TOKEN']);
	});

	it('returns no env gaps while config status is loading or fully satisfied', () => {
		expect(missingPluginEnvironmentVariables(definition, undefined)).toEqual([]);
		expect(missingPluginEnvironmentVariables(definition, {})).toEqual([]);
	});
});

describe('enableTimeMissingEnvVars', () => {
	const mailExternal = {
		key: 'mail.external',
		category: 'receiving',
		label: 'Connect external mailbox',
		description: 'Connect an existing mailbox over IMAP+SMTP.',
		default: false,
		requiredEnvVars: ['MAIL_SYNC_API_URL', 'MAIL_SYNC_API_KEY'],
	} satisfies FeatureFlagDefinition;

	it('names only the variables the deployment is missing', () => {
		expect(
			enableTimeMissingEnvVars(mailExternal, { 'mail.external': ['MAIL_SYNC_API_URL'] })
		).toEqual(['MAIL_SYNC_API_URL']);
	});

	it('names nothing when the deployment already has them all', () => {
		expect(enableTimeMissingEnvVars(mailExternal, {})).toEqual([]);
	});

	it('names the full declared list when the config status is unavailable', () => {
		expect(enableTimeMissingEnvVars(mailExternal, undefined)).toEqual([
			'MAIL_SYNC_API_URL',
			'MAIL_SYNC_API_KEY',
		]);
		expect(enableTimeMissingEnvVars(mailExternal, null)).toEqual([
			'MAIL_SYNC_API_URL',
			'MAIL_SYNC_API_KEY',
		]);
	});

	it('names nothing for a flag that declares no variables', () => {
		const flag = { ...mailExternal, requiredEnvVars: undefined } as FeatureFlagDefinition;
		expect(enableTimeMissingEnvVars(flag, undefined)).toEqual([]);
	});
});
