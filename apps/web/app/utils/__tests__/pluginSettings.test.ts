import { describe, it, expect } from 'vitest';
import type { PluginSettingsSchema } from '@owlat/plugin-kit';
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

	it('falls back to the first select option when there is no default or stored value', () => {
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
		expect(baselineFieldValue(schema[0]!, EMPTY)).toBe('a');
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
});
