import { describe, expect, it } from 'vitest';
import { applySetupDefaults } from '../setupEnvDefaults';

/**
 * The decision plane's one default, and the much larger promise around it: an
 * install that never entered a decision key must come out of setup byte-for-byte
 * the way it came out before the plane existed.
 *
 * `DECISION_PROVIDER` is only consulted by the backend when the stored config
 * names no adapter, and unset there means the language-backed one — so the only
 * thing this default does is stop a deployment from carrying a TypeSafe key that
 * nothing ever reads.
 */
describe('applySetupDefaults: the decision plane', () => {
	it('writes neither decision variable for an install with no key', () => {
		const env: Record<string, string> = {};
		applySetupDefaults(env, 'selfhost');
		expect(env['DECISION_PROVIDER']).toBeUndefined();
		expect(env['TYPESAFE_API_KEY']).toBeUndefined();
	});

	it('names the adapter when a key is present and nothing names one', () => {
		const env: Record<string, string> = { TYPESAFE_API_KEY: 'placeholder-not-a-real-key' };
		applySetupDefaults(env, 'selfhost');
		expect(env['DECISION_PROVIDER']).toBe('typesafe');
	});

	it('never overrides an adapter the operator named themselves', () => {
		// Pointing a key-bearing install back at the language model is a
		// legitimate configuration — a key kept for later, the plane parked.
		const env: Record<string, string> = {
			TYPESAFE_API_KEY: 'placeholder-not-a-real-key',
			DECISION_PROVIDER: 'llm',
		};
		applySetupDefaults(env, 'selfhost');
		expect(env['DECISION_PROVIDER']).toBe('llm');
	});

	it('treats an empty key as no key', () => {
		// `.env` readers hand back `''` for `TYPESAFE_API_KEY=`, and an empty
		// credential cannot answer anything.
		const env: Record<string, string> = { TYPESAFE_API_KEY: '' };
		applySetupDefaults(env, 'selfhost');
		expect(env['DECISION_PROVIDER']).toBeUndefined();
	});

	it('leaves every other default untouched by the decision branch', () => {
		const withKey: Record<string, string> = { TYPESAFE_API_KEY: 'placeholder-not-a-real-key' };
		const without: Record<string, string> = {};
		applySetupDefaults(withKey, 'selfhost');
		applySetupDefaults(without, 'selfhost');
		delete withKey['TYPESAFE_API_KEY'];
		delete withKey['DECISION_PROVIDER'];
		expect(withKey).toEqual(without);
	});
});
