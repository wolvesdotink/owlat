/**
 * When a stored key still applies (the server's `stored_key_not_reusable`
 * rule), and which settings-save refusal the form claims for a field.
 */
import { describe, expect, it } from 'vitest';
import { aiSaveRefusalOf, isStoredKeyStranded, storedKeyApplies } from '../aiProviderKeyReuse';

const stored = { isKeySet: true, kind: 'openai', baseUrl: undefined };

describe('storedKeyApplies', () => {
	it('applies to the same kind and an equivalent address', () => {
		expect(storedKeyApplies(stored, { kind: 'openai' })).toBe(true);
		expect(storedKeyApplies(stored, { kind: 'openai', baseUrl: '  ' })).toBe(true);
		expect(
			storedKeyApplies(
				{ ...stored, baseUrl: 'https://Proxy.example.com:443/v1/' },
				{ kind: 'openai', baseUrl: 'https://proxy.example.com/v1' }
			)
		).toBe(true);
	});

	it('does not apply across a kind change, a new address, or a removed one', () => {
		expect(storedKeyApplies(stored, { kind: 'anthropic' })).toBe(false);
		expect(storedKeyApplies(stored, { kind: 'openai', baseUrl: 'https://proxy.example.com' })).toBe(
			false
		);
		expect(
			storedKeyApplies({ ...stored, baseUrl: 'https://proxy.example.com' }, { kind: 'openai' })
		).toBe(false);
	});

	it('never applies without a stored key', () => {
		expect(storedKeyApplies(null, { kind: 'openai' })).toBe(false);
		expect(storedKeyApplies({ ...stored, isKeySet: false }, { kind: 'openai' })).toBe(false);
	});
});

describe('isStoredKeyStranded', () => {
	it('is a stored key the form no longer targets', () => {
		expect(isStoredKeyStranded(stored, { kind: 'google' })).toBe(true);
		expect(isStoredKeyStranded(stored, { kind: 'openai' })).toBe(false);
		expect(isStoredKeyStranded({ ...stored, isKeySet: false }, { kind: 'google' })).toBe(false);
		expect(isStoredKeyStranded(null, { kind: 'google' })).toBe(false);
	});
});

describe('aiSaveRefusalOf', () => {
	it('reads the stored-key refusal off data.reason', () => {
		expect(
			aiSaveRefusalOf({
				category: 'invalid_input',
				message: 'x',
				data: { reason: 'stored_key_not_reusable', plane: 'embedding' },
			})
		).toEqual({ kind: 'storedKeyNotReusable', plane: 'embedding' });
	});

	it('claims nothing else, nor a refusal naming an unknown plane', () => {
		expect(aiSaveRefusalOf({ category: 'internal', message: 'x' })).toBeNull();
		// The pre-provenance embedding lock no longer exists (D8 switch path).
		expect(
			aiSaveRefusalOf({
				category: 'conflict',
				message: 'x',
				data: { reason: 'embedding_space_locked' },
			})
		).toBeNull();
		expect(
			aiSaveRefusalOf({
				category: 'invalid_input',
				message: 'x',
				data: { reason: 'stored_key_not_reusable', plane: 'vision' },
			})
		).toBeNull();
	});
});
