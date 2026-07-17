import { describe, expect, it } from 'vitest';
import { validatePluginManifest, type PluginManifest } from '../manifest';
import {
	redactPluginSettingsValues,
	validatePluginSettingsInput,
	type PluginSettingsSchema,
} from '../settingsSchema';

function manifestWithSchema(settingsSchema: unknown): Record<string, unknown> {
	return {
		id: 'acme',
		version: '1.0.0',
		capabilities: [],
		settingsSchema,
	};
}

function firstIssuePath(value: unknown): string | undefined {
	const result = validatePluginManifest(value);
	return result.ok ? undefined : result.issues[0]?.path;
}

const EXAMPLE_SCHEMA: PluginSettingsSchema = [
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
			{ value: 'eu', label: 'Europe' },
			{ value: 'us', label: 'United States' },
		],
	},
];

describe('settingsSchema manifest validation', () => {
	it('accepts a well-formed schema with every field kind', () => {
		const result = validatePluginManifest(manifestWithSchema(EXAMPLE_SCHEMA));
		expect(result.ok).toBe(true);
	});

	it('accepts a manifest without a settingsSchema', () => {
		const result = validatePluginManifest({ id: 'acme', version: '1.0.0', capabilities: [] });
		expect(result.ok).toBe(true);
	});

	it('rejects a non-array settingsSchema', () => {
		expect(firstIssuePath(manifestWithSchema({}))).toBe('$.settingsSchema');
	});

	it('rejects an unknown field kind', () => {
		expect(firstIssuePath(manifestWithSchema([{ kind: 'color', key: 'x', label: 'X' }]))).toBe(
			'$.settingsSchema[0].kind'
		);
	});

	it('rejects an unsupported field property for the declared kind', () => {
		// `options` only belongs to select fields.
		expect(
			firstIssuePath(manifestWithSchema([{ kind: 'string', key: 'x', label: 'X', options: [] }]))
		).toBe('$.settingsSchema[0].options');
	});

	it('rejects a reserved or malformed field key', () => {
		expect(
			firstIssuePath(manifestWithSchema([{ kind: 'string', key: '__proto__', label: 'X' }]))
		).toBe('$.settingsSchema[0].key');
		expect(
			firstIssuePath(manifestWithSchema([{ kind: 'string', key: 'has-dash', label: 'X' }]))
		).toBe('$.settingsSchema[0].key');
	});

	it('rejects duplicate field keys', () => {
		expect(
			firstIssuePath(
				manifestWithSchema([
					{ kind: 'string', key: 'dup', label: 'One' },
					{ kind: 'number', key: 'dup', label: 'Two' },
				])
			)
		).toBe('$.settingsSchema[1].key');
	});

	it('rejects a number default outside its declared range', () => {
		expect(
			firstIssuePath(
				manifestWithSchema([{ kind: 'number', key: 'n', label: 'N', min: 0, max: 10, default: 99 }])
			)
		).toBe('$.settingsSchema[0].default');
	});

	it('rejects min greater than max', () => {
		expect(
			firstIssuePath(
				manifestWithSchema([{ kind: 'number', key: 'n', label: 'N', min: 10, max: 1 }])
			)
		).toBe('$.settingsSchema[0].min');
	});

	it('rejects a select default that is not a declared option', () => {
		expect(
			firstIssuePath(
				manifestWithSchema([
					{
						kind: 'select',
						key: 's',
						label: 'S',
						default: 'missing',
						options: [{ value: 'a', label: 'A' }],
					},
				])
			)
		).toBe('$.settingsSchema[0].default');
	});

	it('rejects a select with no options', () => {
		expect(
			firstIssuePath(manifestWithSchema([{ kind: 'select', key: 's', label: 'S', options: [] }]))
		).toBe('$.settingsSchema[0].options');
	});

	it('rejects duplicate option values', () => {
		expect(
			firstIssuePath(
				manifestWithSchema([
					{
						kind: 'select',
						key: 's',
						label: 'S',
						options: [
							{ value: 'a', label: 'A' },
							{ value: 'a', label: 'A2' },
						],
					},
				])
			)
		).toBe('$.settingsSchema[0].options[1].value');
	});

	it('rejects an accessor property inside a field (TOCTOU defense)', () => {
		const field: Record<string, unknown> = { kind: 'string', label: 'X' };
		Object.defineProperty(field, 'key', { enumerable: true, get: () => 'x' });
		expect(firstIssuePath(manifestWithSchema([field]))).toBe('$.settingsSchema[0].key');
	});
});

describe('redactPluginSettingsValues', () => {
	it('drops secret plaintext and reports only whether each secret is set', () => {
		const redacted = redactPluginSettingsValues(EXAMPLE_SCHEMA, {
			endpoint: 'https://prod',
			apiKey: 'super-secret',
			timeout: 45,
		});
		expect(redacted.values).toEqual({
			endpoint: 'https://prod',
			timeout: 45,
			verbose: false,
			region: 'eu',
		});
		expect(Object.values(redacted.values)).not.toContain('super-secret');
		expect(redacted.secretsSet).toEqual({ apiKey: true });
	});

	it('reports an unset secret as false', () => {
		const redacted = redactPluginSettingsValues(EXAMPLE_SCHEMA, {});
		expect(redacted.secretsSet).toEqual({ apiKey: false });
	});

	it('treats an empty stored secret as unset', () => {
		const redacted = redactPluginSettingsValues(EXAMPLE_SCHEMA, { apiKey: '' });
		expect(redacted.secretsSet).toEqual({ apiKey: false });
	});
});

describe('validatePluginSettingsInput', () => {
	it('accepts a valid partial update', () => {
		const result = validatePluginSettingsInput(EXAMPLE_SCHEMA, {
			endpoint: 'https://x',
			timeout: 5,
		});
		expect(result).toEqual({ ok: true, values: { endpoint: 'https://x', timeout: 5 } });
	});

	it('rejects an unknown key', () => {
		const result = validatePluginSettingsInput(EXAMPLE_SCHEMA, { nope: 'x' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.issues[0]?.key).toBe('nope');
	});

	it('rejects a wrong-typed value', () => {
		const result = validatePluginSettingsInput(EXAMPLE_SCHEMA, { timeout: 'soon' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.issues[0]?.key).toBe('timeout');
	});

	it('rejects an out-of-range number', () => {
		const result = validatePluginSettingsInput(EXAMPLE_SCHEMA, { timeout: 9999 });
		expect(result.ok).toBe(false);
	});

	it('rejects an empty secret', () => {
		const result = validatePluginSettingsInput(EXAMPLE_SCHEMA, { apiKey: '' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.issues[0]?.message).toMatch(/empty/);
	});

	it('rejects a select value outside the options', () => {
		const result = validatePluginSettingsInput(EXAMPLE_SCHEMA, { region: 'apac' });
		expect(result.ok).toBe(false);
	});

	it('rejects a non-object input', () => {
		expect(validatePluginSettingsInput(EXAMPLE_SCHEMA, null).ok).toBe(false);
		expect(validatePluginSettingsInput(EXAMPLE_SCHEMA, []).ok).toBe(false);
	});
});

describe('snapshot immutability', () => {
	it('freezes the validated settingsSchema so later mutation cannot diverge', () => {
		const input = manifestWithSchema([{ kind: 'string', key: 'x', label: 'X' }]);
		const result = validatePluginManifest(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const schema = (result.manifest as PluginManifest).settingsSchema;
		expect(Object.isFrozen(schema)).toBe(true);
		expect(schema && Object.isFrozen(schema[0])).toBe(true);
	});
});
