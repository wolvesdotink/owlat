import { describe, it, expect } from 'vitest';
import { fitsForwardedArgBudget } from '../inboundWebhookHttp';

/**
 * The argument budget `POST /webhooks/mta-inbound` forwards under.
 *
 * Standing outside the webhook pipeline removes the 5 MiB pre-auth body cap,
 * but Convex still caps a FUNCTION'S ARGUMENTS at 16 MiB — and this route
 * forwards the base64 message alongside the bodies the MTA already parsed out
 * of it. Near the listener limit those add up past the cap, `runAction` throws, the
 * route answers 500, and the MTA retries six times and dead-letters mail it
 * could have delivered. So the size question is asked BEFORE the call, and the
 * handler drops the raw bytes rather than the message. It is this route's
 * ceiling and not the mailbox route's, because only this one has a
 * deliver-without-the-raw branch to take — see the function's own comment.
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
