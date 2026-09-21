/**
 * External receiving (send-only sending domains) — provider detection, the SPF
 * fold, and the fail-soft MX preflight.
 *
 * The three things that go wrong here are all silent: a suffix match that
 * accepts an attacker's lookalike domain as Google, an SPF fold that drops the
 * operator's trailing qualifier (or the include their real mail provider needs),
 * and an MX lookup failure that throws into the setup screen instead of
 * degrading to "not confirmed".
 */

import { describe, it, expect } from 'vitest';
import {
	externalReceivingSpfMerged,
	inspectExternalReceivingMx,
	mergeExternalReceivingSpf,
} from '../externalReceiving';

/** Resolver stub: one MX answer per host name handed in. */
const resolving = (...exchanges: string[]) => ({
	resolveMx: async () => exchanges.map((exchange) => ({ exchange })),
});

/** The classifier's verdict for one MX set — the module's only way out. */
const providerFor = async (...exchanges: string[]) =>
	(await inspectExternalReceivingMx('acme.example', null, resolving(...exchanges))).provider;

describe('provider detection', () => {
	// The table, the include lookup and the classifier are module-private: every
	// caller gets a finished answer, so they are exercised through the two
	// functions that produce one.
	it('detects Google Workspace from its classic MX set', async () => {
		expect(
			await providerFor(
				'aspmx.l.google.com.',
				'alt1.aspmx.l.google.com.',
				'alt2.aspmx.l.google.com.'
			)
		).toBe('google');
	});

	it('detects the older googlemail.com hosts and the 2023+ single-MX setup', async () => {
		expect(await providerFor('aspmx2.googlemail.com')).toBe('google');
		expect(await providerFor('smtp.google.com')).toBe('google');
	});

	it('detects Microsoft 365 from its tenant MX', async () => {
		expect(await providerFor('owlat-app.mail.protection.outlook.com.')).toBe('microsoft');
	});

	it('returns null — never "other" — for an unrecognised MX set', async () => {
		// `'other'` is an operator DECLARATION about a domain; a lookup cannot
		// observe it, and returning it here would let a failed detection overwrite
		// what the operator said.
		expect(await providerFor('mx1.fastmail.com')).toBeNull();
		expect(await providerFor()).toBeNull();
	});

	it('matches on a dot boundary, so a lookalike domain is not reported as Google', async () => {
		expect(await providerFor('mx.notgoogle.com')).toBeNull();
		expect(await providerFor('mx.evil-googlemail.com')).toBeNull();
		// The registrable domain itself still matches.
		expect(await providerFor('google.com')).toBe('google');
	});

	it('folds the trailing root dot and case before matching', async () => {
		expect(await providerFor(' ASPMX.L.GOOGLE.COM. ')).toBe('google');
	});
});

describe('mergeExternalReceivingSpf', () => {
	const ours = 'v=spf1 include:spf.owlat.example ~all';

	it('folds the provider include into ONE record, before the trailing qualifier', () => {
		expect(mergeExternalReceivingSpf(ours, 'google')).toBe(
			'v=spf1 include:spf.owlat.example include:_spf.google.com ~all'
		);
	});

	it('preserves a hard-fail qualifier the operator configured', () => {
		expect(mergeExternalReceivingSpf('v=spf1 include:spf.owlat.example -all', 'microsoft')).toBe(
			'v=spf1 include:spf.owlat.example include:spf.protection.outlook.com -all'
		);
	});

	it('leaves our record untouched for "other" and for an unset provider', () => {
		expect(mergeExternalReceivingSpf(ours, 'other')).toBe(ours);
		expect(mergeExternalReceivingSpf(ours, undefined)).toBe(ours);
	});

	it('is idempotent — re-folding the same provider does not duplicate the include', () => {
		const once = mergeExternalReceivingSpf(ours, 'google');
		expect(mergeExternalReceivingSpf(once, 'google')).toBe(once);
	});

	it('keeps ip4 mechanisms and every other term of our record', () => {
		expect(
			mergeExternalReceivingSpf('v=spf1 ip4:203.0.113.10 include:spf.owlat.example ~all', 'google')
		).toBe('v=spf1 ip4:203.0.113.10 include:spf.owlat.example include:_spf.google.com ~all');
	});
});

describe('externalReceivingSpfMerged', () => {
	// The panel's "SPF is already merged, publish it exactly as shown" claim is
	// derived from THIS, because deriving it from the declared provider is wrong
	// in every configuration where the backend did not (or could not) merge: a
	// relay-primary domain switched after registration, a deployment with no
	// MTA_SPF_INCLUDE, a row with no SPF record. Telling those operators the
	// merge is done leaves their real mail provider unauthorized.
	const ours = 'v=spf1 include:spf.owlat.example ~all';

	it('is true only once the record actually carries the provider include', () => {
		expect(externalReceivingSpfMerged(mergeExternalReceivingSpf(ours, 'google'), 'google')).toBe(
			true
		);
		expect(externalReceivingSpfMerged(ours, 'google')).toBe(false);
	});

	it('answers per provider, not per record — a Google merge is not a Microsoft one', () => {
		const merged = mergeExternalReceivingSpf(ours, 'google');
		expect(externalReceivingSpfMerged(merged, 'microsoft')).toBe(false);
	});

	it("reads a relay provider's own record honestly", () => {
		// SES's generated apex record, left untouched by a mode switch. Claiming it
		// is merged is exactly the lie this function exists to prevent.
		expect(externalReceivingSpfMerged('v=spf1 include:amazonses.com -all', 'google')).toBe(false);
	});

	it('is false for a missing record rather than throwing', () => {
		expect(externalReceivingSpfMerged(undefined, 'google')).toBe(false);
		expect(externalReceivingSpfMerged(null, 'google')).toBe(false);
		expect(externalReceivingSpfMerged('   ', 'google')).toBe(false);
	});

	it('is false for "other" and for an unset provider — there was no include to add', () => {
		expect(externalReceivingSpfMerged(ours, 'other')).toBe(false);
		expect(externalReceivingSpfMerged(ours, undefined)).toBe(false);
	});

	it('matches whole terms, so a lookalike include is not read as merged', () => {
		expect(
			externalReceivingSpfMerged('v=spf1 include:_spf.google.com.evil.example ~all', 'google')
		).toBe(false);
		expect(externalReceivingSpfMerged('v=spf1 include:not_spf.google.com ~all', 'google')).toBe(
			false
		);
	});

	it('ignores case and surrounding whitespace, which DNS answers carry freely', () => {
		expect(externalReceivingSpfMerged('  V=SPF1  INCLUDE:_SPF.GOOGLE.COM  ~ALL ', 'google')).toBe(
			true
		);
	});
});

describe('inspectExternalReceivingMx', () => {
	it('reports the provider and the normalized hosts for a Google-hosted domain', async () => {
		const result = await inspectExternalReceivingMx(
			'acme.example',
			'mail.owlat.example',
			resolving('ASPMX.L.GOOGLE.COM.', 'alt1.aspmx.l.google.com.')
		);
		expect(result).toEqual({
			hasMx: true,
			hosts: ['aspmx.l.google.com', 'alt1.aspmx.l.google.com'],
			provider: 'google',
			pointsHere: false,
		});
	});

	it('raises pointsHere when the apex MX resolves to this deployment', async () => {
		// The domain says receiving stays external, but our MX is published — the
		// customer's inbound mail has already been taken away from their provider.
		const result = await inspectExternalReceivingMx(
			'acme.example',
			'Mail.Owlat.Example',
			resolving('mail.owlat.example.')
		);
		expect(result.pointsHere).toBe(true);
		expect(result.provider).toBeNull();
		expect(result.hasMx).toBe(true);
	});

	it('cannot point here when the deployment has no mail host configured', async () => {
		const result = await inspectExternalReceivingMx(
			'acme.example',
			null,
			resolving('mail.owlat.example')
		);
		expect(result.pointsHere).toBe(false);
	});

	it('resolves to "not confirmed" instead of throwing when the lookup fails', async () => {
		const result = await inspectExternalReceivingMx('acme.example', 'mail.owlat.example', {
			resolveMx: async () => {
				throw new Error('queryMx ENOTFOUND acme.example');
			},
		});
		expect(result).toEqual({ hasMx: false, hosts: [], provider: null, pointsHere: false });
	});

	it('reports no MX for a domain that answers with an empty set', async () => {
		const result = await inspectExternalReceivingMx('acme.example', 'mail.owlat.example', {
			resolveMx: async () => [],
		});
		expect(result.hasMx).toBe(false);
		expect(result.provider).toBeNull();
	});
});
