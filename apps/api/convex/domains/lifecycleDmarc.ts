/**
 * Sending domain lifecycle — DMARC policy editor.
 *
 * `setDmarcPolicy` regenerates the `_dmarc` record from the domain's policy
 * settings. It never moves `domains.status` and writes only through
 * `patchDomainRecords` (see the module map in `lifecycle.ts`).
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { patchDomainRecords } from './lifecycle';
import type { DnsRecords, VerificationResults } from './lifecycleReducer';
import {
	buildDmarcRecordValue,
	DEFAULT_DMARC_POLICY,
	dmarcPolicyValidator,
	dmarcRuaFromEnv,
} from './dmarc';

type SendingDomainDmarcOutcome =
	| { ok: true; policy: 'none' | 'quarantine' | 'reject'; changed: boolean }
	| { ok: false; reason: 'domain_not_found' | 'no_dmarc_record' };

/**
 * Raise (or lower) the domain's DMARC enforcement policy, plus the optional
 * RFC 7489 §6.3 enforcement knobs (`sp=` subdomain policy, `pct=` staged
 * rollout). Regenerates the `_dmarc` TXT record value from the new settings
 * and clears the stale DMARC verification result — the customer must re-publish
 * the changed record, so a previously-verified domain drops back to needing a
 * re-verify on the DMARC record only. Single writer of `domains.dmarcPolicy` +
 * `domains.dmarcSubdomainPolicy` + `domains.dmarcPct` + `dnsRecords`, written through
 * `patchDomainRecords`. Does not move `domains.status`; verification is a
 * separate, explicit user action.
 *
 * Passing `undefined` for `subdomainPolicy`/`pct` clears the corresponding tag
 * (the field is removed from the row); passing a value sets it. The change is a
 * no-op only when all three settings already match what's stored.
 */
export const setDmarcPolicy = internalMutation({
	args: {
		domainId: v.id('domains'),
		policy: dmarcPolicyValidator,
		subdomainPolicy: v.optional(dmarcPolicyValidator),
		pct: v.optional(v.number()),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<SendingDomainDmarcOutcome> => {
		const domain = await ctx.db.get(args.domainId);
		if (!domain) return { ok: false, reason: 'domain_not_found' };

		const dnsRecords = domain.dnsRecords as DnsRecords;
		const dmarc = dnsRecords.dmarc;
		if (!dmarc) return { ok: false, reason: 'no_dmarc_record' };

		const currentPolicy = domain.dmarcPolicy ?? DEFAULT_DMARC_POLICY;
		const unchanged =
			currentPolicy === args.policy &&
			domain.dmarcSubdomainPolicy === args.subdomainPolicy &&
			domain.dmarcPct === args.pct;
		if (unchanged) {
			return { ok: true, policy: args.policy, changed: false };
		}

		const at = Date.now();
		// `buildDmarcRecordValue` throws on an out-of-range `pct=` (RFC 7489
		// requires an integer 0–100) — surface that to the caller rather than
		// publishing a record receivers will ignore.
		const nextValue = buildDmarcRecordValue(domain.domain, {
			policy: args.policy,
			subdomainPolicy: args.subdomainPolicy,
			pct: args.pct,
			rua: dmarcRuaFromEnv(),
		});
		const nextDnsRecords: DnsRecords = {
			...dnsRecords,
			dmarc: { ...dmarc, value: nextValue },
		};

		// The published DMARC record now differs from what the customer has in
		// DNS — drop the stale DMARC verification result so the UI prompts a
		// re-publish + re-verify of just that record.
		const verificationResults = domain.verificationResults as VerificationResults | undefined;
		const nextVerificationResults: VerificationResults | undefined = verificationResults
			? { ...verificationResults, dmarc: undefined }
			: undefined;

		await patchDomainRecords(
			ctx,
			domain,
			{
				dnsRecords: nextDnsRecords,
				dmarcPolicy: args.policy,
				// `undefined` removes the field from the row, clearing the tag.
				dmarcSubdomainPolicy: args.subdomainPolicy,
				dmarcPct: args.pct,
				...(nextVerificationResults !== undefined
					? { verificationResults: nextVerificationResults }
					: {}),
				updatedAt: at,
			},
			{
				userId: args.userId,
				action: 'sending_domain.dmarc_policy_changed',
				details: {
					domain: domain.domain,
					previousPolicy: currentPolicy,
					newPolicy: args.policy,
					newSubdomainPolicy: args.subdomainPolicy ?? null,
					newPct: args.pct ?? null,
					applied: 'transitioned',
				},
			}
		);

		return { ok: true, policy: args.policy, changed: true };
	},
});
