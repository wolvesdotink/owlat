/**
 * Sending domain lifecycle — DKIM rotation editor.
 *
 * `recordDkimRotation` is the MTA's callback when it rotates a domain's DKIM
 * key. It rewrites the published DKIM records and never moves `domains.status`.
 * Writes only through `patchDomainRecords` (see the module map in
 * `lifecycle.ts`).
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { patchDomainRecords } from './lifecycle';
import type { DnsRecords, VerificationResults } from './lifecycleReducer';

type SendingDomainDkimRotationOutcome =
	| { ok: true; phase: 'pending' | 'activated'; selector: string; changed: boolean }
	| { ok: false; reason: 'domain_not_found' };

/**
 * MTA→Convex callback for DKIM key rotation. The MTA owns key material in
 * Redis and runs the publish-then-switch overlap workflow (RFC 6376 §3.6.1,
 * M3AAWG guidance); Convex stores the customer-facing `dnsRecords` once at
 * registration, so without this callback a rotation would leave the customer
 * looking at — and `verifyDomain` checking — the stale selector forever.
 *
 * Two phases, mirroring the MTA rotation workflow:
 *   - `'pending'`   (rotation initiated): the new selector's record is
 *                   *added* alongside the active one. Both are published in
 *                   DNS during the overlap, so the customer can publish the
 *                   new record and `verifyDomain` checks BOTH selectors. The
 *                   new record's DKIM verification result is cleared so the UI
 *                   prompts a publish + re-verify of just the new selector.
 *   - `'activated'` (signing switched): the old selector is retired and only
 *                   the new selector's record remains.
 *
 * Looks the domain up by name (the MTA only knows the domain string). A
 * domain that isn't registered with the MTA provider — or was removed — is a
 * no-op miss (`domain_not_found`); the caller logs + drops it.
 *
 * Single writer of `domains.dnsRecords.dkim` for the rotation path, written through
 * `patchDomainRecords`. Does not move `domains.status`.
 */
export const recordDkimRotation = internalMutation({
	args: {
		domain: v.string(),
		selector: v.string(),
		dnsRecord: v.string(),
		phase: v.union(v.literal('pending'), v.literal('activated')),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<SendingDomainDkimRotationOutcome> => {
		const normalized = args.domain.toLowerCase();
		const domain = await ctx.db
			.query('domains')
			.withIndex('by_domain', (q) => q.eq('domain', normalized))
			.first();
		if (!domain) return { ok: false, reason: 'domain_not_found' };

		const newHost = `${args.selector}._domainkey`;
		const newRecord = { type: 'TXT' as const, host: newHost, value: args.dnsRecord };

		const dnsRecords = domain.dnsRecords as DnsRecords;
		const existingDkim = dnsRecords.dkim ?? [];

		// The new selector's host index in the existing bundle (rotation re-runs
		// or a record that drifted into the bundle already).
		const existingIndexOfNew = existingDkim.findIndex((r) => r.host === newHost);

		let nextDkim: NonNullable<DnsRecords['dkim']>;
		if (args.phase === 'pending') {
			// Overlap: keep the active selector(s), add (or refresh) the new one.
			nextDkim =
				existingIndexOfNew >= 0
					? existingDkim.map((r, i) => (i === existingIndexOfNew ? newRecord : r))
					: [...existingDkim, newRecord];
		} else {
			// Activated: retire every other selector, keep only the new one.
			nextDkim = [newRecord];
		}

		// No-op when the bundle already reads exactly as it would after the patch.
		const unchanged =
			existingDkim.length === nextDkim.length &&
			existingDkim.every(
				(r, i) =>
					r.host === nextDkim[i]!.host &&
					r.value === nextDkim[i]!.value &&
					r.type === nextDkim[i]!.type
			);
		if (unchanged) {
			return { ok: true, phase: args.phase, selector: args.selector, changed: false };
		}

		const at = Date.now();
		const nextDnsRecords: DnsRecords = { ...dnsRecords, dkim: nextDkim };

		// The published DKIM bundle now differs from what the customer has in DNS
		// — drop the stale per-selector DKIM verification results so the UI
		// prompts a re-publish + re-verify (mirrors `setDmarcPolicy`). The array
		// shape no longer aligns 1:1 with the new selector set, so clear it
		// wholesale; the next `verifyDomain` re-populates it against the new hosts.
		const verificationResults = domain.verificationResults as VerificationResults | undefined;
		const nextVerificationResults: VerificationResults | undefined = verificationResults
			? { ...verificationResults, dkim: undefined }
			: undefined;

		await patchDomainRecords(
			ctx,
			domain,
			{
				dnsRecords: nextDnsRecords,
				...(nextVerificationResults !== undefined
					? { verificationResults: nextVerificationResults }
					: {}),
				updatedAt: at,
			},
			{
				userId: args.userId,
				action: 'sending_domain.dkim_rotated',
				details: {
					domain: domain.domain,
					selector: args.selector,
					phase: args.phase,
					applied: 'transitioned',
				},
			}
		);

		return { ok: true, phase: args.phase, selector: args.selector, changed: true };
	},
});
