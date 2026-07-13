/**
 * `senderAuthDisplay` is the single source of truth BOTH From-pickers (the
 * campaign wizard and the Postbox composer) key their chip copy AND their
 * disable-with-reason send-gate off. The honesty-critical claim is the `blocked`
 * decision — a state may only block a send for a DEFINITE problem it actually
 * checked. These tests pin `blocked` for all four states so the gate can never
 * drift from the copy:
 *   - verified + aligned    → NOT blocked (clean identity)
 *   - verified + unknown    → NOT blocked (undeclared relay: a caution, not a
 *                             verified failure — "unknown never blocks")
 *   - verified + misaligned → blocked (DMARC will fail)
 *   - unverified            → blocked (sending is genuinely off)
 */
import { describe, it, expect } from 'vitest';

import { senderAuthDisplay } from '../senderAlignment';

describe('senderAuthDisplay — block decision (honesty gate)', () => {
	it('does NOT block a verified, aligned identity', () => {
		const display = senderAuthDisplay({ verified: true, alignment: 'aligned' });
		expect(display.blocked).toBe(false);
		expect(display.tone).toBe('success');
		expect(display.label).toBe('Sender verified');
		expect(display.detail).toBeNull();
	});

	it('NEVER blocks an unknown (undeclared-relay) alignment — a caution, not a failure', () => {
		const display = senderAuthDisplay({ verified: true, alignment: 'unknown' });
		expect(display.blocked).toBe(false);
		expect(display.tone).toBe('warning');
		expect(display.label).toBe('Alignment unconfirmed');
	});

	it('blocks a misaligned transport (DMARC will fail)', () => {
		const display = senderAuthDisplay({ verified: true, alignment: 'misaligned' });
		expect(display.blocked).toBe(true);
		expect(display.tone).toBe('error');
		expect(display.label).toBe('Sender not aligned');
	});

	it('blocks an unverified domain regardless of alignment', () => {
		for (const alignment of ['aligned', 'unknown', 'misaligned'] as const) {
			const display = senderAuthDisplay({ verified: false, alignment });
			expect(display.blocked).toBe(true);
			expect(display.tone).toBe('warning');
			expect(display.label).toBe('Domain not verified');
		}
	});

	it('passes the alignment reason through verbatim when one is supplied', () => {
		const reason = 'This transport signs and bounces mail as “sendgrid.net”.';
		const display = senderAuthDisplay({ verified: true, alignment: 'misaligned', reason });
		expect(display.detail).toBe(reason);
	});
});
