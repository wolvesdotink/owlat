/**
 * The relay-domain identity state, worded for whichever relay reported it.
 *
 * These cases were `mandrillRelayStatus.test.ts`'s: the same judgements, moved
 * with the code when the per-vendor panel pair collapsed into one. Two things
 * they now assert that the vendor version could not — that the provider's NAME
 * comes from the row, and that a kind reporting no freshness bound is never aged
 * out — are the whole difference between copy that generalises and copy that
 * merely stopped naming a vendor.
 */
import { describe, expect, it } from 'vitest';
import {
	isRelayProofFresh,
	relayDomainDisplay,
	relayDomainOutstanding,
	type RelayDomainIdentityRow,
	type RelayDomainText,
} from '../relayDomainDisplay';
import { createTestI18n } from '~/__tests__/i18n';

// The vocabulary is a pure derivation, so labels and summaries arrive as
// message keys (a summary with the relay's name as its interpolation); the copy
// an operator reads is resolved through the real catalog.
const { t } = createTestI18n().global;
const say = (value: RelayDomainText) =>
	typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});

const WEEK = 7 * 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 5, 12);

function row(over: Partial<RelayDomainIdentityRow> = {}): RelayDomainIdentityRow {
	return {
		kind: 'mandrill',
		kindLabel: 'Mailchimp Transactional (Mandrill)',
		domain: 'example.com',
		status: 'verified',
		spf: { isValid: true },
		dkim: { isValid: true },
		lastCheckedAt: NOW - 1000,
		proofMaxAgeMs: WEEK,
		isOwnershipVerified: true,
		...over,
	};
}

describe('relayDomainDisplay', () => {
	it('reads verified only while the proof is inside the kind’s own bound', () => {
		const display = relayDomainDisplay(row(), NOW);
		expect(say(display.label)).toBe('Verified');
		expect(display.tone).toBe('success');
		expect(display.isProofStale).toBe(false);
	});

	it('reads "re-checking", not verified, once the proof has aged out', () => {
		// Routing stops trusting a proof this old, so a screen still saying
		// "verified" would name the relay usable at the moment it stopped being.
		const stale = relayDomainDisplay(row({ lastCheckedAt: NOW - WEEK - 1 }), NOW);
		expect(say(stale.label)).toBe('Re-checking');
		expect(stale.tone).toBe('warning');
		expect(stale.isProofStale).toBe(true);
		expect(say(stale.summary)).toContain('older than Owlat will rely on');
	});

	it('treats exactly the bound as still fresh', () => {
		expect(say(relayDomainDisplay(row({ lastCheckedAt: NOW - WEEK }), NOW).label)).toBe('Verified');
	});

	it('never ages out a kind that reports no freshness bound', () => {
		// A window the router does not apply is not ours to invent: "re-checking"
		// for a proof routing is happy with is a false alarm on an operator's
		// screen, for a relay that never told us how long its evidence lasts.
		const unbounded = row({ proofMaxAgeMs: undefined, lastCheckedAt: NOW - 10 * WEEK });
		expect(say(relayDomainDisplay(unbounded, NOW).label)).toBe('Verified');
		expect(isRelayProofFresh(unbounded, NOW)).toBe(true);
	});

	it('names the relay from the row rather than from the copy', () => {
		const plugin = relayDomainDisplay(
			row({ kind: 'plugin.mail-pack.postmark', kindLabel: 'Postmark' }),
			NOW
		);
		expect(say(plugin.summary)).toContain('Postmark');
		expect(say(plugin.summary)).not.toContain('Mandrill');
	});

	it('distinguishes "nothing published yet" from "waiting on DNS"', () => {
		expect(
			say(relayDomainDisplay(row({ status: 'unverified', isOwnershipVerified: false }), NOW).label)
		).toBe('Not published yet');
		expect(
			say(relayDomainDisplay(row({ status: 'pending', isOwnershipVerified: false }), NOW).label)
		).toBe('Waiting on DNS');
	});

	it('separates the two states no provider reports: provisioning and the primary domain', () => {
		// Both are facts about the DOMAIN, synthesised by the query — a relay with
		// no row for a domain cannot distinguish them, and neither reads as an error.
		expect(say(relayDomainDisplay(row({ status: 'provisioning' }), NOW).label)).toBe(
			'Provisioning'
		);
		expect(
			say(relayDomainDisplay(row({ status: 'awaiting_primary_verification' }), NOW).label)
		).toBe('Waiting on this domain');
	});

	it('names a rejected credential as a key problem, not a DNS problem', () => {
		const display = relayDomainDisplay(row({ status: 'failed', isOwnershipVerified: false }), NOW);
		expect(display.tone).toBe('error');
		expect(say(display.summary)).toContain('Your published DNS is untouched');
	});

	it('flags outstanding ownership on every unverified state of a kind that has one', () => {
		for (const status of ['unverified', 'pending', 'failed'] as const) {
			expect(
				relayDomainDisplay(row({ status, isOwnershipVerified: false }), NOW).needsOwnership
			).toBe(true);
		}
		expect(relayDomainDisplay(row(), NOW).needsOwnership).toBe(false);
	});

	it('says nothing about ownership for a kind with no such ceremony', () => {
		// SES verifies FROM the records it asks for. Reporting an outstanding
		// ownership step would send an operator looking for a console flow that
		// does not exist.
		const ses = row({
			kind: 'ses',
			kindLabel: 'Amazon SES',
			status: 'pending',
			spf: undefined,
			dkim: undefined,
			isOwnershipVerified: undefined,
		});
		expect(relayDomainDisplay(ses, NOW).needsOwnership).toBe(false);
		expect(relayDomainOutstanding(ses)).toEqual([]);
	});
});

describe('isRelayProofFresh', () => {
	it('rejects a check timestamped in the future', () => {
		// An unexplainable clock is not evidence — fail closed, like routing does.
		expect(isRelayProofFresh(row({ lastCheckedAt: NOW + 1 }), NOW)).toBe(false);
	});
});

describe('relayDomainOutstanding', () => {
	it('lists the three items in the order an operator works them', () => {
		expect(
			relayDomainOutstanding(
				row({
					spf: { isValid: false },
					dkim: { isValid: false },
					isOwnershipVerified: false,
				})
			).map((item) => t(item))
		).toEqual(['SPF', 'DKIM', 'domain ownership']);
	});

	it('keeps ownership outstanding even when both records are valid', () => {
		expect(
			relayDomainOutstanding(row({ isOwnershipVerified: false })).map((item) => t(item))
		).toEqual(['domain ownership']);
	});

	it('is empty for a fully verified domain', () => {
		expect(relayDomainOutstanding(row())).toEqual([]);
	});
});
