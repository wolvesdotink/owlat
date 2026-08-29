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

import {
	alignmentSendWarning,
	selectedSenderIdentity,
	senderAuthDisplay,
} from '../senderAlignment';
import { createTestI18n } from '~/__tests__/i18n';

/**
 * The chip copy arrives as catalog keys, so the assertions render them; a
 * transport's own worded reason passes straight through, which `t()` leaves
 * alone because it is not a key the catalog carries.
 */
const { t } = createTestI18n().global;

describe('senderAuthDisplay — block decision (honesty gate)', () => {
	it('does NOT block a verified, aligned identity', () => {
		const display = senderAuthDisplay({ verified: true, alignment: 'aligned' });
		expect(display.blocked).toBe(false);
		expect(display.tone).toBe('success');
		expect(t(display.label)).toBe('Sender verified');
		expect(display.detail).toBeNull();
	});

	it('NEVER blocks an unknown (undeclared-relay) alignment — a caution, not a failure', () => {
		const display = senderAuthDisplay({ verified: true, alignment: 'unknown' });
		expect(display.blocked).toBe(false);
		expect(display.tone).toBe('warning');
		expect(t(display.label)).toBe('Alignment unconfirmed');
	});

	it('blocks a misaligned transport (DMARC will fail)', () => {
		const display = senderAuthDisplay({ verified: true, alignment: 'misaligned' });
		expect(display.blocked).toBe(true);
		expect(display.tone).toBe('error');
		expect(t(display.label)).toBe('Sender not aligned');
	});

	it('blocks an unverified domain regardless of alignment', () => {
		for (const alignment of ['aligned', 'unknown', 'misaligned'] as const) {
			const display = senderAuthDisplay({ verified: false, alignment });
			expect(display.blocked).toBe(true);
			expect(display.tone).toBe('warning');
			expect(t(display.label)).toBe('Domain not verified');
		}
	});

	it('passes the alignment reason through verbatim when one is supplied', () => {
		const reason = 'This transport signs and bounces mail as “sendgrid.net”.';
		const display = senderAuthDisplay({ verified: true, alignment: 'misaligned', reason });
		expect(t(display.detail!)).toBe(reason);
	});
});

describe('selectedSenderIdentity', () => {
	const identities = [
		{ address: 'ada@northwind.studio', domainVerified: true, alignment: 'aligned' as const },
		{ address: 'billing@northwind.studio', domainVerified: false, alignment: 'aligned' as const },
	];

	it('finds the chosen From', () => {
		expect(selectedSenderIdentity(identities, 'billing@northwind.studio')?.domainVerified).toBe(
			false
		);
	});

	it('falls back to the first identity, which is what the picker displays', () => {
		expect(selectedSenderIdentity(identities, '')?.address).toBe('ada@northwind.studio');
	});

	it('is null when there is nothing to send as, or the From is unknown', () => {
		expect(selectedSenderIdentity([], 'ada@northwind.studio')).toBeNull();
		expect(selectedSenderIdentity(identities, 'gone@elsewhere.test')).toBeNull();
	});
});

describe('alignmentSendWarning — the pre-send gate (idea 3)', () => {
	it('warns about the two DEFINITE failures', () => {
		expect(t(alignmentSendWarning({ verified: false, alignment: 'aligned' })!.label)).toBe(
			'Domain not verified'
		);
		expect(t(alignmentSendWarning({ verified: true, alignment: 'misaligned' })!.label)).toBe(
			'Sender not aligned'
		);
	});

	it('stays silent on a clean identity and on an unverified alignment', () => {
		expect(alignmentSendWarning({ verified: true, alignment: 'aligned' })).toBeNull();
		expect(alignmentSendWarning({ verified: true, alignment: 'unknown' })).toBeNull();
	});

	it('is silent when there is no identity to judge', () => {
		expect(alignmentSendWarning(null)).toBeNull();
	});

	it('carries the transport reason into the warning', () => {
		const reason = 'This transport signs and bounces mail as “sendgrid.net”.';
		const warning = alignmentSendWarning({ verified: true, alignment: 'misaligned', reason });
		expect(t(warning!.detail!)).toBe(reason);
	});
});
