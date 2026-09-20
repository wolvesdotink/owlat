import { describe, it, expect } from 'vitest';
import { base64ByteLength, fitsForwardedArgBudget } from '../mtaRawRoute';

/**
 * The argument budget the two raw-carrying MTA routes forward under.
 *
 * Standing outside the webhook pipeline removes the 5 MiB pre-auth body cap,
 * but Convex still caps a FUNCTION'S ARGUMENTS at 16 MiB — and these routes
 * forward the base64 message alongside the bodies the MTA already parsed out of
 * it. Near the listener limit those add up past the cap, `runAction` throws, the
 * route answers 500, and the MTA retries six times and dead-letters mail it
 * could have delivered. So the size question is asked BEFORE the call, and the
 * handler drops the raw bytes rather than the message.
 *
 * Pure function, exercised directly: proving this through the HTTP handler
 * would mean signing and posting a 17 MiB body on every run.
 */
describe('fitsForwardedArgBudget', () => {
	const MiB = 1024 * 1024;

	it('accepts the ordinary case — one message and its bodies', () => {
		expect(fitsForwardedArgBudget(['x'.repeat(MiB), 'body', '<p>body</p>'])).toBe(true);
	});

	it('ignores absent values rather than counting them', () => {
		expect(fitsForwardedArgBudget([undefined, undefined])).toBe(true);
	});

	it('accepts a message at the listener cap once base64 has inflated it', () => {
		// 10 MiB of mail is ~13.3 MiB of base64 — the size this route exists to
		// carry. It must not be what the budget refuses.
		expect(fitsForwardedArgBudget(['x'.repeat(Math.ceil((10 * MiB * 4) / 3))])).toBe(true);
	});

	it('refuses that same message once a multi-megabyte HTML body rides along', () => {
		expect(
			fitsForwardedArgBudget(['x'.repeat(Math.ceil((10 * MiB * 4) / 3)), 'y'.repeat(3 * MiB)])
		).toBe(false);
	});

	it('counts UTF-8 BYTES, not characters', () => {
		// 6 MiB of three-byte characters is 18 MiB on the wire. Counting code
		// units would call that a comfortable fit and then throw at the call.
		expect(fitsForwardedArgBudget(['한'.repeat(6 * MiB)])).toBe(false);
		// The same character count in ASCII does fit, which is the whole reason
		// the distinction matters.
		expect(fitsForwardedArgBudget(['a'.repeat(6 * MiB)])).toBe(true);
	});
});

describe('base64ByteLength', () => {
	it('reports the decoded size, ignoring MIME line wrapping and padding', () => {
		const raw = 'hello inbound world';
		const wrapped = Buffer.from(raw)
			.toString('base64')
			.replace(/(.{4})/g, '$1\r\n');
		expect(base64ByteLength(wrapped)).toBe(raw.length);
	});

	it('answers undefined for anything that is not a string', () => {
		// The field comes off the wire: a number or an object here used to reach
		// `.endsWith` and throw into the audit writer's catch, which meant NO
		// audit row for exactly the malformed deliveries worth auditing.
		expect(base64ByteLength(42)).toBeUndefined();
		expect(base64ByteLength({ length: 10 })).toBeUndefined();
		expect(base64ByteLength(undefined)).toBeUndefined();
	});
});
