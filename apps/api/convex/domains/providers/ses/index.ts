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

import { internal } from '../../../_generated/api';
import { createSESIdentityManager } from '../../../lib/emailProviders/sesIdentity';
import { getOptional } from '../../../lib/env';
import { logError } from '../../../lib/runtimeLog';
import { buildDmarcRecordValue, DEFAULT_DMARC_POLICY } from '../../dmarc';
import { buildSesMailFromRecords, resolveSesMailFrom } from './mailFrom';
import { sesReferenceArm } from './referenceArm';
import { sesRelayDomainVerified } from './relayVerification';
import type { DnsRecord, DnsRecords } from '../../domains';
import type {
	ProviderCheckResult,
	ProviderVerificationStatusFields,
	RelayProvingProviderModule,
	SesIdentity,
} from '../types';

// `RelayProvingProviderModule`, not the plain module type: the catalog declares
// `domainVerification: 'api'` for this kind, and that promise is only worth
// something if the three relay seams below are REQUIRED here (see the type's
// own comment, and `../index.ts`'s `_relayProofTypecheck`).
export const sesProvider: RelayProvingProviderModule<'ses'> = {
	kind: 'ses',

	async registerDomain(domain, options) {
		const ses = createSESIdentityManager();

		// Per-domain custom MAIL FROM (X1): a `returnPathHost` set on the domain
		// overrides the default `mail.<domain>` subdomain. SES requires the MAIL
		// FROM to be a subdomain of the sending identity, so a non-subdomain host
		// is a hard error (rolls into the `→ failed` transition). Absent → the
		// historic `mail.<domain>` default, unchanged.
		const mailFrom = resolveSesMailFrom(domain, options?.returnPathHost);
		if (!mailFrom) {
			throw new Error(
				`SES custom MAIL FROM host "${options?.returnPathHost}" must be a subdomain of ${domain}`
			);
		}

		// 1. Register domain identity + DKIM tokens.
		const { verificationToken, dkimTokens } = await ses.registerDomain(domain);

		// 2. Set up the custom MAIL FROM subdomain. The setupMailFromDomain call
		//    is part of "register" — if it throws, the whole operation
		//    rolls into the `→ failed` transition.
		await ses.setupMailFromDomain(domain, mailFrom.host);

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
				value: 'v=spf1 include:amazonses.com -all',
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
			// The MX + SPF TXT SES requires at the (default or override) MAIL FROM
			// subdomain (see `mailFrom.ts` — SES's shape, not the MTA's).
			mailFrom: buildSesMailFromRecords(mailFrom.host, region),
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

	/**
	 * SES's verdict as `verificationResults.sesStatus` has always held it — the
	 * ONE statement of that spelling, shared with the relay-identity refresher in
	 * `domains/sesRelayVerification.ts`. It lived in `domains/dnsVerification.ts`
	 * behind `providerType === 'ses'`, which made "does this provider have a
	 * verdict worth recording?" a question about a name rather than about the
	 * provider.
	 *
	 * The field is persisted and currently read by nothing in `apps/web` — see
	 * {@link ProviderVerificationStatusFields}; implementing this keeps the
	 * verdict in the domain's record, it does not put anything on a screen.
	 */
	verificationStatusFields(check: ProviderCheckResult): ProviderVerificationStatusFields {
		return { sesStatus: check.verified ? 'Success' : 'Pending' };
	},

	// The relay-verification read seam (Mandrill plan D6). SES is the one shipped kind that
	// declares `domainVerification: 'api'`, so it is the one kind that can
	// answer this; see `./relayVerification.ts` for the proof it requires.
	relayDomainVerified: sesRelayDomainVerified,

	// The alignment pre-flight's second arm (see `./referenceArm.ts`) — the same
	// arm this deployment has always compared against, now answered through the
	// registry instead of an `=== 'ses'` branch in the pre-flight.
	describeReferenceArm: sesReferenceArm,

	/**
	 * The relay-identity backfill. Byte-identical to what the drain in
	 * `providerRoutes.ts` used to do inline — the same existence read on the
	 * frozen `sendingDomainSesIdentities` sibling, the same scheduled
	 * `sesRelay.provision` — moved behind the contract so the drain can ask it
	 * of whichever kind the route actually named (the seams plan's D2 —
	 * capabilities, not identity).
	 */
	async ensureRelayIdentity(ctx, domain) {
		const existing = await ctx.db
			.query('sendingDomainSesIdentities')
			.withIndex('by_domain', (q) => q.eq('domainId', domain._id))
			.first();
		if (existing) return;
		await ctx.scheduler.runAfter(0, internal.domains.sesRelay.provision, { domainId: domain._id });
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
