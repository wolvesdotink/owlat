/**
 * MTA sending domain provider adapter.
 *
 * Owns the MTA-side surface of one **Sending domain** — provider API calls
 * (`registerDomain`, `deleteFromProvider`) and the
 * `sendingDomainMtaIdentities` sibling table (`writeIdentity`,
 * `clearIdentity`).
 *
 * MTA has no provider-side verification call, so `runProviderCheck` is
 * omitted — the lifecycle treats absent as `{ verified: true }`.
 *
 * Per ADR-0018.
 */

import { createMtaIdentityManager } from '../../../lib/emailProviders/mtaIdentity';
import { getOptional } from '../../../lib/env';
import { logWarn } from '../../../lib/runtimeLog';
import { buildDmarcRecordValue, DEFAULT_DMARC_POLICY } from '../../dmarc';
import { buildTlsRptRecordValue, TLSRPT_HOST } from '../../tlsRpt';
import { buildReturnPathSpfRecord, buildSpfRecordValue, resolveSpfQualifier } from '../../spf';
import type { DnsRecord, DnsRecords } from '../../domains';
import type { MtaIdentity, SendingDomainProviderModule } from '../types';

export const mtaProvider: SendingDomainProviderModule<'mta'> = {
	kind: 'mta',

	async registerDomain(domain) {
		const mta = createMtaIdentityManager();
		const { selector, dnsRecord } = await mta.registerDomain(domain);

		const dkimRecords: DnsRecord[] = [
			{
				type: 'TXT',
				host: `${selector}._domainkey`,
				value: dnsRecord,
			},
		];

		const dnsRecords: DnsRecords = {
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
		};

		// SPF trailing qualifier: soft-fail (`~all`) by default, hard-fail
		// (`-all`) once the operator sets SPF_QUALIFIER and the IP set is stable
		// (RFC 7208 §5.1).
		const qualifier = resolveSpfQualifier(getOptional('SPF_QUALIFIER'));

		// Optional SPF include on the From-domain apex — only emitted when
		// MTA_SPF_INCLUDE is set.
		const spfInclude = getOptional('MTA_SPF_INCLUDE');
		if (spfInclude) {
			dnsRecords.spf = {
				type: 'TXT',
				host: '@',
				value: buildSpfRecordValue({ include: spfInclude, qualifier }),
			};
		} else {
			logWarn(
				`[MTA] MTA_SPF_INCLUDE not set — SPF record omitted for ${domain}. DKIM+DMARC alignment is still functional.`,
			);
		}

		// Optional SMTP TLS Reporting (`_smtp._tls`, RFC 8460 §3) — only emitted
		// when MTA_TLSRPT_RUA is set. This is the reciprocal of the STS/TLS-RPT
		// the MTA already consumes for recipients: it asks others to report TLS
		// failures delivering mail TO the operator's domain. To actually enforce
		// strict TLS the operator additionally publishes an `_mta-sts` TXT record
		// plus an `https://mta-sts.<domain>/.well-known/mta-sts.txt` policy file
		// (RFC 8461) — that policy file lives on the operator's web host, not in
		// DNS, so we document it rather than generate it here.
		const tlsRptValue = buildTlsRptRecordValue(getOptional('MTA_TLSRPT_RUA'));
		if (tlsRptValue) {
			dnsRecords.tlsRpt = {
				type: 'TXT',
				host: TLSRPT_HOST,
				value: tlsRptValue,
			};
		}

		// Return-path SPF: the bounce envelope is `bounce+…@RETURN_PATH_DOMAIN`,
		// so SPF authenticates the return-path domain — NOT the From-domain apex.
		// For DMARC SPF alignment, and so the bounce envelope passes SPF at all,
		// the operator must publish an SPF record on RETURN_PATH_DOMAIN
		// authorizing the pool IPs (RFC 7489 §3.1). When the operator tells the
		// Convex backend the return-path domain + pool IPs, we emit that record
		// into the DNS bundle as a `mailFrom` entry keyed by the absolute
		// hostname (it lives on a sibling domain, not under the From-domain).
		const returnPathDomain = getOptional('MTA_RETURN_PATH_DOMAIN')?.trim();
		const poolIps = (getOptional('MTA_IP_POOLS') ?? '')
			.split(',')
			.map((ip) => ip.trim())
			.filter(Boolean);
		if (returnPathDomain && poolIps.length > 0) {
			dnsRecords.mailFrom = [
				{
					type: 'TXT',
					hostname: returnPathDomain,
					value: buildReturnPathSpfRecord(poolIps, qualifier),
				},
			];
		} else if (returnPathDomain) {
			logWarn(
				`[MTA] MTA_RETURN_PATH_DOMAIN is set but MTA_IP_POOLS is empty — return-path SPF record omitted for ${domain}. The bounce envelope (bounce+…@${returnPathDomain}) will not pass SPF.`,
			);
		}

		return {
			dnsRecords,
			identity: {
				kind: 'mta',
				dkimSelector: selector,
			} satisfies MtaIdentity,
		};
	},

	async deleteFromProvider(domain) {
		const mta = createMtaIdentityManager();
		await mta.deleteDomain(domain);
	},

	describeIdentity(identity) {
		return `DKIM selector "${identity.dkimSelector}"`;
	},

	// runProviderCheck — omitted. MTA has no provider-side verification call.

	async writeIdentity(ctx, domainId, identity) {
		const existing = await ctx.db
			.query('sendingDomainMtaIdentities')
			.withIndex('by_domain', (q) => q.eq('domainId', domainId))
			.first();
		const now = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, {
				dkimSelector: identity.dkimSelector,
				updatedAt: now,
			});
			return;
		}
		await ctx.db.insert('sendingDomainMtaIdentities', {
			domainId,
			dkimSelector: identity.dkimSelector,
			createdAt: now,
			updatedAt: now,
		});
	},

	async clearIdentity(ctx, domainId) {
		const existing = await ctx.db
			.query('sendingDomainMtaIdentities')
			.withIndex('by_domain', (q) => q.eq('domainId', domainId))
			.first();
		if (existing) {
			await ctx.db.delete(existing._id);
		}
	},
};
