/**
 * The stored-key reuse rule both the server (`saveConfig`) and the settings
 * form apply: a key stays with its plane while the provider kind and the
 * normalized base URL are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { isSameKeyTarget } from '../aiModelCatalog';

describe('isSameKeyTarget', () => {
	it('matches the same kind with no base URL on either side', () => {
		expect(
			isSameKeyTarget({ kind: 'openai', baseUrl: undefined }, { kind: 'openai', baseUrl: '' })
		).toBe(true);
	});

	it('compares base URLs by what they address', () => {
		const a = { kind: 'openai', baseUrl: 'HTTPS://Proxy.Example.com:443/v1///' };
		const b = { kind: 'openai', baseUrl: ' https://proxy.example.com/v1 ' };
		expect(isSameKeyTarget(a, b)).toBe(true);
		expect(isSameKeyTarget(a, { kind: 'openai', baseUrl: 'https://proxy.example.com/v2' })).toBe(
			false
		);
		expect(
			isSameKeyTarget(a, { kind: 'openai', baseUrl: 'https://proxy.example.com:8443/v1' })
		).toBe(false);
	});

	it('never matches across kinds, or an explicit URL with an absent one', () => {
		expect(
			isSameKeyTarget({ kind: 'openai', baseUrl: undefined }, { kind: 'azure', baseUrl: undefined })
		).toBe(false);
		expect(
			isSameKeyTarget(
				{ kind: 'openai', baseUrl: 'https://api.openai.com/v1' },
				{ kind: 'openai', baseUrl: undefined }
			)
		).toBe(false);
	});

	it('keeps the query, and treats an unparsable value as text', () => {
		expect(
			isSameKeyTarget(
				{ kind: 'azure', baseUrl: 'https://r.example.com/?api-version=1' },
				{ kind: 'azure', baseUrl: 'https://r.example.com/?api-version=2' }
			)
		).toBe(false);
		expect(
			isSameKeyTarget({ kind: 'x', baseUrl: 'not a url/' }, { kind: 'x', baseUrl: 'not a url' })
		).toBe(true);
	});
});
