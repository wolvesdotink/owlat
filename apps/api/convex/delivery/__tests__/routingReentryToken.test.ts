import { describe, expect, it } from 'vitest';
import { callbackDigest } from '../routingReentryToken';

/**
 * A routing re-entry token carries this digest from issue to callback, and a
 * token issued before a deploy is checked after it, so the digest bytes are a
 * cross-release contract. These vectors were produced by the serializer that
 * preceded the shared `canonicalJson`; they cover key order, integer-like keys,
 * undefined members and array entries, null, non-finite numbers and escaping.
 */
describe('callbackDigest golden vectors', () => {
	const retryState = { attempt: 1, startedAt: 1, idempotencyKey: 'k' };
	const cases: Array<{
		name: string;
		envelopeInput: unknown;
		retryState: unknown;
		digest: string;
	}> = [
		{
			name: 'a minimal transactional envelope',
			envelopeInput: { kind: 'transactional' },
			retryState: { attempt: 1, startedAt: 1_700_000_000_000, idempotencyKey: 'msg-001' },
			digest: 'M6xvHw65QHYzB83dnECGhzoF-RyP98W82K3ajccgQ5Y',
		},
		{
			name: 'nested objects, undefined members, null, integer-like keys and escapes',
			envelopeInput: {
				kind: 'campaign',
				to: 'user@example.com',
				headers: { 'Reply-To': 'reply@example.com', 'X-B': 'b', 'X-A': 'a' },
				tags: ['z', 'a', null],
				replyTo: null,
				skipped: undefined,
				nested: { b: [1, { d: 2, c: undefined }], a: -0, e: 1.5e-7, u: 'é\u2028"\\' },
				10: 'ten',
				2: 'two',
			},
			retryState: {
				attempt: 3,
				startedAt: 1_700_000_000_123,
				idempotencyKey: 'msg-002',
				nan: Number.NaN,
				inf: Infinity,
			},
			digest: 'Ct-_JWeDSG7IndK8EcwYuccjZggUdc6GsojG26vfveY',
		},
		{
			name: 'an array envelope with an undefined entry and a null retry state',
			envelopeInput: [undefined, 1, 'x'],
			retryState: null,
			digest: 'X9Bf0_58JEnD4tEVzYnNV7xkBgiB0ciuOf0HI2eWPis',
		},
		{
			name: 'an undefined envelope',
			envelopeInput: undefined,
			retryState: { attempt: 0, startedAt: 0, idempotencyKey: '' },
			digest: 'Lg82bXRymtsdTBUO52CyMf-7r8iqD2POgKAN-TeVpng',
		},
		{
			name: 'code-unit key order across case, accents, astral and full-width keys',
			envelopeInput: {
				'': 1,
				B: 2,
				a: 3,
				é: 4,
				'\ud83d\ude00': 5,
				ｚ: 6,
				big: 1.2345678901234567e19,
			},
			retryState,
			digest: 'AjmVcjO_hri-p6MvLfQbOhWCpPVDlJP5QBhWA81R6GA',
		},
		{
			name: 'a Convex bytes value',
			envelopeInput: { buf: new ArrayBuffer(4) },
			retryState,
			digest: '-QdhOLluPWsOZYTtdWGkLrZ3mPwrXYBHM7TwR9dWEXM',
		},
	];

	it.each(cases)('pins the digest of $name', async (vector) => {
		expect(await callbackDigest(vector.envelopeInput, vector.retryState)).toBe(vector.digest);
	});
});
