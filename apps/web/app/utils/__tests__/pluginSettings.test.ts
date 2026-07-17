import { describe, it, expect } from 'vitest';
import type { PluginSettingsField, PluginSettingsSchema } from '@owlat/plugin-kit';
import {
	baselineFieldValue,
	hasPluginSettingsChanges,
	missingRequiredPluginSettings,
	pluginSettingsBaseline,
	pluginSettingsChanges,
	type PluginSettingsRedactedState,
} from '../pluginSettings';

const SCHEMA: PluginSettingsSchema = [
	{ kind: 'string', key: 'endpoint', label: 'Endpoint', default: 'https://api.test' },
	{ kind: 'secret', key: 'apiKey', label: 'API key', required: true },
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
	it('uses stored values, and always blanks secrets regardless of stored state', () => {
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

	it('never submits a blank secret, so a stored secret is kept', () => {
		const form = { ...baseline, apiKey: '' };
		expect(pluginSettingsChanges(SCHEMA, form, baseline)).toEqual({});
	});

	it('submits a typed secret replacement', () => {
		const form = { ...baseline, apiKey: 'rotated-secret' };
		expect(pluginSettingsChanges(SCHEMA, form, baseline)).toEqual({ apiKey: 'rotated-secret' });
		expect(hasPluginSettingsChanges(SCHEMA, form, baseline)).toBe(true);
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
	it('is satisfied by an already-stored secret even when the input is blank', () => {
		const baseline = pluginSettingsBaseline(SCHEMA, CONFIGURED);
		expect(missingRequiredPluginSettings(SCHEMA, baseline, CONFIGURED)).toEqual([]);
	});

	it('flags a required secret that is neither stored nor typed', () => {
		const baseline = pluginSettingsBaseline(SCHEMA, EMPTY);
		expect(missingRequiredPluginSettings(SCHEMA, baseline, EMPTY)).toEqual(['apiKey']);
	});

	it('is satisfied by a freshly typed secret when none is stored', () => {
		const baseline = pluginSettingsBaseline(SCHEMA, EMPTY);
		const form = { ...baseline, apiKey: 'first' };
		expect(missingRequiredPluginSettings(SCHEMA, form, EMPTY)).toEqual([]);
	});

	it('flags a required string left empty', () => {
		const schema: PluginSettingsSchema = [
			{ kind: 'string', key: 'name', label: 'Name', required: true },
		];
		const state: PluginSettingsRedactedState = { values: {}, secretsSet: {} };
		const baseline = pluginSettingsBaseline(schema, state);
		expect(missingRequiredPluginSettings(schema, baseline, state)).toEqual(['name']);
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
		expect(missingRequiredPluginSettings(schema, baseline, state)).toEqual(['port', 'mode']);
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
		expect(missingRequiredPluginSettings(schema, form, state)).toEqual([]);
	});
});
