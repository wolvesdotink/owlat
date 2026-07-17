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
import {
	buildReturnPathMailFromRecords,
	buildSpfRecordValue,
	parsePoolIps,
	resolveSpfQualifier,
} from '../../spf';
import type { DnsRecord, DnsRecords } from '../../domains';
import type { MtaIdentity, SendingDomainProviderModule } from '../types';

export const mtaProvider: SendingDomainProviderModule<'mta'> = {
	kind: 'mta',

	async registerDomain(domain, options) {
		// Per-domain VERP return-path host (D1/D2): a custom host set on the
		// `domains` row overrides the deployment-global `MTA_RETURN_PATH_DOMAIN`.
		// The custom host (when present) is reflected to the MTA so its VERP MAIL
		// FROM for this domain becomes `bounce+…@<host>`; when absent we send no
		// host and the MTA keeps its global (historic behavior).
		const customReturnPathHost = options?.returnPathHost?.trim() || undefined;

		const mta = createMtaIdentityManager();
		const { selector, dnsRecord } = await mta.registerDomain(domain, customReturnPathHost);

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
				`[MTA] MTA_SPF_INCLUDE not set — SPF record omitted for ${domain}. DKIM+DMARC alignment is still functional.`
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

		// Return-path bundle: the bounce envelope is `bounce+…@<return-path host>`,
		// so the host needs BOTH an MX (so remote MTAs can DELIVER DSNs back to the
		// MTA's inbound listener at EHLO_HOSTNAME) and an SPF TXT authorizing the
		// pool IPs (so the envelope passes SPF, RFC 7489 §3.1). The host is the
		// domain's per-domain override when set (D1/D2), else the global
		// `MTA_RETURN_PATH_DOMAIN`. Emitted as `mailFrom` entries keyed by the
		// absolute hostname (a sibling of the From-domain, not under it).
		const returnPathHost = customReturnPathHost ?? getOptional('MTA_RETURN_PATH_DOMAIN')?.trim();
		const poolIps = parsePoolIps(getOptional('MTA_IP_POOLS'));
		const mailHost = getOptional('EHLO_HOSTNAME')?.trim();
		const mailFromRecords = buildReturnPathMailFromRecords(
			returnPathHost,
			poolIps,
			qualifier,
			mailHost
		);
		if (mailFromRecords) {
			dnsRecords.mailFrom = mailFromRecords;
		}
		if (returnPathHost && !mailHost) {
			logWarn(
				`[MTA] return-path host ${returnPathHost} is set but EHLO_HOSTNAME is empty — no bounce MX emitted for ${domain}. Remote MTAs cannot deliver DSNs to bounce+…@${returnPathHost}.`
			);
		}
		if (returnPathHost && poolIps.length === 0) {
			logWarn(
				`[MTA] return-path host ${returnPathHost} is set but MTA_IP_POOLS is empty — return-path SPF record omitted for ${domain}. The bounce envelope (bounce+…@${returnPathHost}) will not pass SPF.`
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
