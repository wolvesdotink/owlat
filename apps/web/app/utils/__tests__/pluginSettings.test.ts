import { describe, it, expect } from 'vitest';
import type { PluginSettingsField, PluginSettingsSchema } from '@owlat/plugin-kit';
import {
	baselineFieldValue,
	hasPluginSettingsChanges,
	missingRequiredPluginSettings,
	pluginSettingsBaseline,
	pluginSettingsChanges,
	unsetRequiredPluginSecrets,
	type PluginSettingsRedactedState,
} from '../pluginSettings';

const SCHEMA: PluginSettingsSchema = [
	{ kind: 'string', key: 'endpoint', label: 'Endpoint', default: 'https://api.test' },
	{ kind: 'secret', key: 'apiKey', envVar: 'PLUGIN_API_KEY', label: 'API key', required: true },
	{ kind: 'number', key: 'timeout', label: 'Timeout', default: 30, min: 1, max: 120 },
	{ kind: 'boolean', key: 'verbose', label: 'Verbose', default: false },
	{
		kind: 'select',
		key: 'region',
		label: 'Region',
		default: 'eu',
		options: [
			{ value: 'eu', label: 'EU' },
			{ value: 'us', label: 'US' },
		],
	},
];

const CONFIGURED: PluginSettingsRedactedState = {
	values: { endpoint: 'https://prod', timeout: 45, verbose: true, region: 'us' },
	secretsSet: { apiKey: true },
};

const EMPTY: PluginSettingsRedactedState = { values: {}, secretsSet: { apiKey: false } };

describe('pluginSettingsBaseline', () => {
	it('uses stored values, and never seeds an env-supplied secret', () => {
		expect(pluginSettingsBaseline(SCHEMA, CONFIGURED)).toEqual({
			endpoint: 'https://prod',
			apiKey: '',
			timeout: 45,
			verbose: true,
			region: 'us',
		});
	});

	it('falls back to schema defaults when nothing is stored', () => {
		expect(pluginSettingsBaseline(SCHEMA, EMPTY)).toEqual({
			endpoint: 'https://api.test',
			apiKey: '',
			timeout: 30,
			verbose: false,
			region: 'eu',
		});
	});

	it('baselines an unset select to "" (the placeholder), not a fabricated first option', () => {
		const schema: PluginSettingsSchema = [
			{
				kind: 'select',
				key: 'mode',
				label: 'Mode',
				options: [
					{ value: 'a', label: 'A' },
					{ value: 'b', label: 'B' },
				],
			},
		];
		expect(baselineFieldValue(schema[0]!, EMPTY)).toBe('');
	});

	it('treats a stored select value dropped from the options as unset', () => {
		// A newer plugin version removed the 'legacy' option; the stored value must
		// not render as configured. With a default it falls back to the default,
		// without one it falls back to '' (the placeholder).
		const stale: PluginSettingsRedactedState = { values: { region: 'legacy' }, secretsSet: {} };
		const regionField = SCHEMA.find((field) => field.key === 'region')!;
		expect(baselineFieldValue(regionField, stale)).toBe('eu');

		const noDefault: PluginSettingsField = {
			kind: 'select',
			key: 'mode',
			label: 'Mode',
			options: [
				{ value: 'a', label: 'A' },
				{ value: 'b', label: 'B' },
			],
		};
		const staleNoDefault: PluginSettingsRedactedState = {
			values: { mode: 'legacy' },
			secretsSet: {},
		};
		expect(baselineFieldValue(noDefault, staleNoDefault)).toBe('');
	});

	it('baselines an unset number to "" (an empty input), not a fabricated min/0', () => {
		const withMin: PluginSettingsField = {
			kind: 'number',
			key: 'port',
			label: 'Port',
			min: 1,
			max: 65535,
		};
		const withoutMin: PluginSettingsField = { kind: 'number', key: 'count', label: 'Count' };
		expect(baselineFieldValue(withMin, EMPTY)).toBe('');
		expect(baselineFieldValue(withoutMin, EMPTY)).toBe('');
	});
});

describe('pluginSettingsChanges', () => {
	const baseline = pluginSettingsBaseline(SCHEMA, CONFIGURED);

	it('is empty when the form equals the baseline', () => {
		expect(pluginSettingsChanges(SCHEMA, { ...baseline }, baseline)).toEqual({});
		expect(hasPluginSettingsChanges(SCHEMA, { ...baseline }, baseline)).toBe(false);
	});

	it('never submits a secret, even if one somehow reaches the form state', () => {
		// Owlat stores no plugin credentials: the value lives in the deployment
		// environment, so the client must not be able to write one either.
		const form = { ...baseline, apiKey: 'rotated-secret' };
		expect(pluginSettingsChanges(SCHEMA, form, baseline)).toEqual({});
		expect(hasPluginSettingsChanges(SCHEMA, form, baseline)).toBe(false);
	});

	it('never submits a cleared number field, so the stored value is kept', () => {
		// The operator blanks the optional number input: it emits '' but must not
		// reach the submitted changes (the server would reject '' as non-finite).
		const form = { ...baseline, timeout: '' as const };
		expect(pluginSettingsChanges(SCHEMA, form, baseline)).toEqual({});
		expect(hasPluginSettingsChanges(SCHEMA, form, baseline)).toBe(false);
	});

	it('still submits a re-typed number after a clear', () => {
		const form = { ...baseline, timeout: 15 };
		expect(pluginSettingsChanges(SCHEMA, form, baseline)).toEqual({ timeout: 15 });
	});

	it('submits only the changed non-secret fields with their typed values', () => {
		const form = { ...baseline, endpoint: 'https://new', timeout: 10, verbose: false };
		expect(pluginSettingsChanges(SCHEMA, form, baseline)).toEqual({
			endpoint: 'https://new',
			timeout: 10,
			verbose: false,
		});
	});
});

describe('missingRequiredPluginSettings', () => {
	it('ignores a required secret entirely, set or not: it has no input to fill', () => {
		// A secret is env-supplied and renders read-only, so gating the save on one
		// would name a field the operator cannot fill and would strand every other
		// setting on the page behind a deployment change.
		expect(
			missingRequiredPluginSettings(SCHEMA, pluginSettingsBaseline(SCHEMA, CONFIGURED))
		).toEqual([]);
		expect(missingRequiredPluginSettings(SCHEMA, pluginSettingsBaseline(SCHEMA, EMPTY))).toEqual(
			[]
		);
	});

	it('flags a required string left empty', () => {
		const schema: PluginSettingsSchema = [
			{ kind: 'string', key: 'name', label: 'Name', required: true },
		];
		const state: PluginSettingsRedactedState = { values: {}, secretsSet: {} };
		const baseline = pluginSettingsBaseline(schema, state);
		expect(missingRequiredPluginSettings(schema, baseline)).toEqual(['name']);
	});

	it('flags a required number/select that is unset with no default', () => {
		const schema: PluginSettingsSchema = [
			{ kind: 'number', key: 'port', label: 'Port', required: true, min: 1 },
			{
				kind: 'select',
				key: 'mode',
				label: 'Mode',
				required: true,
				options: [{ value: 'a', label: 'A' }],
			},
		];
		const state: PluginSettingsRedactedState = { values: {}, secretsSet: {} };
		const baseline = pluginSettingsBaseline(schema, state);
		expect(missingRequiredPluginSettings(schema, baseline)).toEqual(['port', 'mode']);
	});

	it('flags a required select whose stored value is no longer an option', () => {
		const schema: PluginSettingsSchema = [
			{
				kind: 'select',
				key: 'mode',
				label: 'Mode',
				required: true,
				options: [{ value: 'a', label: 'A' }],
			},
		];
		// The plugin upgrade dropped 'legacy'; the baseline is now '' so the required
		// select is flagged rather than silently accepted as a stale, unusable value.
		const state: PluginSettingsRedactedState = { values: { mode: 'legacy' }, secretsSet: {} };
		const baseline = pluginSettingsBaseline(schema, state);
		expect(missingRequiredPluginSettings(schema, baseline)).toEqual(['mode']);
	});

	it('is satisfied once the unset required number/select receive values', () => {
		const schema: PluginSettingsSchema = [
			{ kind: 'number', key: 'port', label: 'Port', required: true, min: 1 },
			{
				kind: 'select',
				key: 'mode',
				label: 'Mode',
				required: true,
				options: [{ value: 'a', label: 'A' }],
			},
		];
		const state: PluginSettingsRedactedState = { values: {}, secretsSet: {} };
		const form = { port: 8080, mode: 'a' };
		expect(missingRequiredPluginSettings(schema, form)).toEqual([]);
	});
});

describe('unsetRequiredPluginSecrets', () => {
	it('reports a required secret whose environment variable is absent', () => {
		expect(unsetRequiredPluginSecrets(SCHEMA, EMPTY).map((field) => field.envVar)).toEqual([
			'PLUGIN_API_KEY',
		]);
	});

	it('reports nothing once the variable is present', () => {
		expect(unsetRequiredPluginSecrets(SCHEMA, CONFIGURED)).toEqual([]);
	});

	it('ignores an optional secret: only a declared precondition is worth a warning', () => {
		const schema: PluginSettingsSchema = [
			{ kind: 'secret', key: 'optional', envVar: 'PLUGIN_OPTIONAL', label: 'Optional' },
		];
		expect(
			unsetRequiredPluginSecrets(schema, { values: {}, secretsSet: { optional: false } })
		).toEqual([]);
	});
});
