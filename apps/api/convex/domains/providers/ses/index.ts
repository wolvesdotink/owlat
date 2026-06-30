/**
 * SES sending domain provider adapter.
 *
 * Owns the SES-side surface of one **Sending domain** — provider API calls
 * (`registerDomain`, `deleteFromProvider`, `runProviderCheck`) and the
 * `sendingDomainSesIdentities` sibling table (`writeIdentity`,
 * `clearIdentity`).
 *
 * Unlike MTA, SES has a provider-side verification call
 * (`getVerificationStatus`) — the lifecycle's reducer combines its boolean
 * verdict with the generic DNS rule to derive `verified | failed | pending`.
 *
 * Per ADR-0018.
 */

import { createSESIdentityManager } from '../../../lib/emailProviders/sesIdentity';
import { getOptional } from '../../../lib/env';
import { logError } from '../../../lib/runtimeLog';
import { buildDmarcRecordValue, DEFAULT_DMARC_POLICY } from '../../dmarc';
import type { DnsRecord, DnsRecords } from '../../domains';
import type {
	ProviderCheckResult,
	SendingDomainProviderModule,
	SesIdentity,
} from '../types';

export const sesProvider: SendingDomainProviderModule<'ses'> = {
	kind: 'ses',

	async registerDomain(domain) {
		const ses = createSESIdentityManager();

		// 1. Register domain identity + DKIM tokens.
		const { verificationToken, dkimTokens } = await ses.registerDomain(domain);

		// 2. Set up custom MAIL FROM subdomain. The setupMailFromDomain call
		//    is part of "register" — if it throws, the whole operation
		//    rolls into the `→ failed` transition.
		await ses.setupMailFromDomain(domain, 'mail');

		const region = ses.getRegion();

		const dkimRecords: DnsRecord[] = dkimTokens.map((token) => ({
			type: 'CNAME' as const,
			host: `${token}._domainkey`,
			value: `${token}.dkim.amazonses.com`,
		}));

		const dnsRecords: DnsRecords = {
			spf: {
				type: 'TXT',
				host: '@',
				value: 'v=spf1 include:amazonses.com ~all',
			},
			dkim: dkimRecords,
			// New domains start in monitor-only mode (`p=none`); the customer
			// raises the policy to quarantine/reject via `setDmarcPolicy`.
			dmarc: {
				type: 'TXT',
				host: '_dmarc',
				value: buildDmarcRecordValue(domain, {
					policy: DEFAULT_DMARC_POLICY,
					rua: getOptional('MTA_DMARC_RUA'),
				}),
			},
			mailFrom: [
				{
					type: 'MX',
					host: 'mail',
					value: `feedback-smtp.${region}.amazonses.com`,
					priority: 10,
				},
				{
					type: 'TXT',
					host: 'mail',
					value: 'v=spf1 include:amazonses.com ~all',
				},
			],
		};

		return {
			dnsRecords,
			identity: {
				kind: 'ses',
				dkimTokens,
				verificationToken,
			} satisfies SesIdentity,
		};
	},

	async deleteFromProvider(domain) {
		const ses = createSESIdentityManager();
		await ses.deleteIdentity(domain);
	},

	describeIdentity(identity) {
		return `${identity.dkimTokens.length} DKIM tokens`;
	},

	async runProviderCheck(domain): Promise<ProviderCheckResult> {
		try {
			const ses = createSESIdentityManager();
			const status = await ses.getVerificationStatus(domain);
			// SES's `verificationStatus` is the source of truth — it returns
			// 'Success' once Amazon's TXT verification clears. Anything else
			// (`Pending`, `Failed`, `TemporaryFailure`, `NotStarted`) means
			// not-yet-verified at the provider level.
			return {
				verified: status.verificationStatus === 'Success',
				...(status.verificationStatus !== 'Success'
					? { lastError: `SES status: ${status.verificationStatus}` }
					: {}),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown SES error';
			logError(`[SES] runProviderCheck failed for ${domain}:`, message);
			return {
				verified: false,
				lastError: `SES check error: ${message}`,
			};
		}
	},

	async writeIdentity(ctx, domainId, identity) {
		const existing = await ctx.db
			.query('sendingDomainSesIdentities')
			.withIndex('by_domain', (q) => q.eq('domainId', domainId))
			.first();
		const now = Date.now();
		const tokens = Array.from(identity.dkimTokens);
		if (existing) {
			await ctx.db.patch(existing._id, {
				dkimTokens: tokens,
				verificationToken: identity.verificationToken,
				updatedAt: now,
			});
			return;
		}
		await ctx.db.insert('sendingDomainSesIdentities', {
			domainId,
			dkimTokens: tokens,
			verificationToken: identity.verificationToken,
			createdAt: now,
			updatedAt: now,
		});
	},

	async clearIdentity(ctx, domainId) {
		const existing = await ctx.db
			.query('sendingDomainSesIdentities')
			.withIndex('by_domain', (q) => q.eq('domainId', domainId))
			.first();
		if (existing) {
			await ctx.db.delete(existing._id);
		}
	},
};
