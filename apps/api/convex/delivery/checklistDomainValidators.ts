'use node';

import dns from 'node:dns/promises';
import { createPublicKey } from 'node:crypto';
import {
	verifyMtaStsPublication,
	type DeliverabilityCheckId,
	type DeliverabilityChecklistStatus,
} from '@owlat/shared';
import type { ActionCtx } from '../_generated/server';
import { api } from '../_generated/api';
import { runDnsLookups } from '../domains/dnsVerification';
import { fetchMtaStsPolicyBody, resolveMtaStsTxt } from '../domains/mtaStsVerify';
import { assertMarketingOneClickSigningContract } from './marketingCompliance';
import { detectDomainDnsProvider, dnsProviderObservation } from './checklistProviderDetection';
import {
	checklistObservation,
	pendingDnsStatus,
	type ChecklistObservation,
	type ChecklistVerificationContext,
} from './checklistValidatorTypes';

const POSTMASTER_MAX_AGE_MS = 48 * 60 * 60 * 1_000;
const POSTMASTER_PERIOD_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1_000;
const DOMAIN_DNS_BUNDLE_ITEMS = new Set<DeliverabilityCheckId>([
	'domain.spf',
	'domain.dkim',
	'domain.dmarc',
	'domain.return_path',
	'domain.tls_rpt',
	'domain.tlsa',
]);
const DNS_PROVIDER_ITEMS = new Set<DeliverabilityCheckId>([
	...DOMAIN_DNS_BUNDLE_ITEMS,
	'domain.mta_sts',
	'domain.tracking',
]);

function parsedDkimKeyBits(value: string | undefined): number | null {
	if (!value) return null;
	const key = /(?:^|;)\s*p=([^;\s]+)/i.exec(value)?.[1]?.replace(/\s+/g, '');
	if (!key) return null;
	try {
		const publicKey = createPublicKey({
			key: Buffer.from(key, 'base64'),
			format: 'der',
			type: 'spki',
		});
		return publicKey.asymmetricKeyType === 'rsa'
			? (publicKey.asymmetricKeyDetails?.modulusLength ?? null)
			: null;
	} catch {
		return null;
	}
}

async function resolveDkimKeyBits(hostname: string): Promise<number | null> {
	const visited = new Set<string>();
	let current = hostname.toLowerCase().replace(/\.$/, '');
	for (let hop = 0; hop < 4 && !visited.has(current); hop += 1) {
		visited.add(current);
		try {
			const txt = (await dns.resolveTxt(current))
				.slice(0, 8)
				.map((chunks) => chunks.join(''))
				.find((value) => /\bv=DKIM1\b/i.test(value) && /(?:^|;)\s*p=/i.test(value));
			if (txt) return parsedDkimKeyBits(txt);
		} catch {
			// A provider-managed selector is commonly a CNAME, so continue.
		}
		try {
			const cname = (await dns.resolveCname(current))[0];
			if (!cname) return null;
			current = cname.toLowerCase().replace(/\.$/, '');
		} catch {
			return null;
		}
	}
	return null;
}

function dnsResultStatus(
	result: { verified: boolean; error?: string } | undefined,
	isFinalDnsRetry: boolean
): DeliverabilityChecklistStatus {
	if (result?.verified) return 'pass';
	const isMissing =
		!result ||
		result.error?.includes('No DNS record') ||
		result.error?.includes('No matching') ||
		result.error?.includes('try again later');
	return isMissing ? pendingDnsStatus(isFinalDnsRetry) : 'fail';
}

export async function observeDomainCheck(
	ctx: ActionCtx,
	itemId: DeliverabilityCheckId,
	context: ChecklistVerificationContext,
	isFinalDnsRetry: boolean
): Promise<ChecklistObservation> {
	const domain = context.domain;
	if (!domain) {
		return checklistObservation(
			'domain.scope',
			'fail',
			'The requested sending domain no longer exists.'
		);
	}
	const providerValues = DNS_PROVIDER_ITEMS.has(itemId)
		? dnsProviderObservation(await detectDomainDnsProvider(domain.domain))
		: [];
	const results = DOMAIN_DNS_BUNDLE_ITEMS.has(itemId)
		? await runDnsLookups(domain.domain, domain.dnsRecords)
		: null;
	const checkedValues = (result?: { foundValue?: string }) =>
		result?.foundValue ? [...providerValues, `observed=${result.foundValue}`] : providerValues;

	switch (itemId) {
		case 'domain.spf': {
			if (!results) throw new Error('SPF DNS observation was not loaded');
			const isStrict = domain.dnsRecords.spf?.value.trim().endsWith('-all') === true;
			const status =
				results.spf?.verified && isStrict ? 'pass' : dnsResultStatus(results.spf, isFinalDnsRetry);
			return checklistObservation(
				'dns.spf',
				status,
				results.spf?.verified && !isStrict
					? 'SPF is published, but it must end in -all for this checklist.'
					: (results.spf?.error ?? 'SPF is live and ends in -all.'),
				checkedValues(results.spf)
			);
		}
		case 'domain.dkim': {
			if (!results) throw new Error('DKIM DNS observation was not loaded');
			const configured = domain.dnsRecords.dkim ?? [];
			const verified = results.dkim?.every((result) => result.verified) && configured.length > 0;
			const keyBits = await Promise.all(
				configured.map((record) => resolveDkimKeyBits(`${record.host}.${domain.domain}`))
			);
			const strong = keyBits.length > 0 && keyBits.every((bits) => bits !== null && bits >= 2_048);
			const hasProviderManagedCname = configured.some((record) => record.type === 'CNAME');
			const status = verified
				? strong
					? 'pass'
					: hasProviderManagedCname
						? 'warn'
						: 'fail'
				: dnsResultStatus(results.dkim?.[0], isFinalDnsRetry);
			return checklistObservation(
				'dns.dkim',
				status,
				verified && hasProviderManagedCname && !strong
					? 'The provider-managed DKIM CNAME is live, but key strength needs message-level proof.'
					: verified && !strong
						? 'The live DKIM key is shorter than 2048 bits or could not be parsed.'
						: (results.dkim?.find((result) => result.error)?.error ??
							'Every DKIM selector is live with a 2048-bit-or-stronger key.'),
				[...providerValues, ...keyBits.map((bits) => `key-bits=${bits ?? 'unknown'}`)]
			);
		}
		case 'domain.dmarc': {
			if (!results) throw new Error('DMARC DNS observation was not loaded');
			const authenticationReady =
				results.spf?.verified === true && results.dkim?.every((result) => result.verified) === true;
			const pass = results.dmarc?.verified === true && authenticationReady;
			return checklistObservation(
				'dns.dmarc-alignment',
				pass ? 'pass' : dnsResultStatus(results.dmarc, isFinalDnsRetry),
				pass
					? 'DMARC is live and the domain has verified SPF and DKIM alignment evidence.'
					: (results.dmarc?.error ?? 'DMARC or its authentication dependencies are missing.'),
				checkedValues(results.dmarc)
			);
		}
		case 'domain.return_path': {
			if (!results) throw new Error('return-path DNS observation was not loaded');
			const pass =
				Boolean(domain.returnPathHost) &&
				Boolean(results.mailFrom?.length) &&
				results.mailFrom?.every((result) => result.verified) === true;
			return checklistObservation(
				'dns.return-path',
				pass ? 'pass' : dnsResultStatus(results.mailFrom?.[0], isFinalDnsRetry),
				pass
					? 'The configured return-path host and every required DNS record are live.'
					: (results.mailFrom?.find((result) => result.error)?.error ??
							'No verified per-domain return path is available.'),
				[
					...providerValues,
					...(domain.returnPathHost ? [`return-path=${domain.returnPathHost}`] : []),
				]
			);
		}
		case 'domain.mta_sts': {
			const expected = await ctx.runQuery(api.domains.mtaSts.getMtaStsPolicy, {});
			if (!expected) {
				return checklistObservation(
					'https.mta-sts',
					'fail',
					'MTA-STS publishing is not enabled for this deployment.',
					providerValues
				);
			}
			const verification = verifyMtaStsPublication(
				{ policyId: expected.policyId, body: expected.body },
				{
					txtValue: await resolveMtaStsTxt(domain.domain),
					servedBody: await fetchMtaStsPolicyBody(domain.domain),
				}
			);
			const pass = verification.txtRecordValid && verification.policyServedValid;
			return checklistObservation(
				'https.mta-sts',
				pass ? 'pass' : pendingDnsStatus(isFinalDnsRetry),
				pass
					? 'The MTA-STS TXT id and HTTPS policy body match.'
					: 'The MTA-STS TXT id or HTTPS policy body does not match.',
				providerValues
			);
		}
		case 'domain.tls_rpt':
			if (!results) throw new Error('TLS-RPT DNS observation was not loaded');
			if (!domain.dnsRecords.tlsRpt || domain.dnsRecords.tlsRpt.type === 'TLSA') {
				return checklistObservation(
					'dns.tls-rpt',
					'warn',
					'No TLS-RPT TXT record is configured.',
					providerValues
				);
			}
			return checklistObservation(
				'dns.tls-rpt',
				dnsResultStatus(results.tlsRpt, isFinalDnsRetry),
				results.tlsRpt?.error ?? 'The TLS-RPT record is live.',
				checkedValues(results.tlsRpt)
			);
		case 'domain.tlsa':
			if (!results) throw new Error('TLSA DNS observation was not loaded');
			if (!domain.dnsRecords.tlsa && domain.dnsRecords.tlsRpt?.type !== 'TLSA') {
				return checklistObservation(
					'dns.tlsa',
					'warn',
					'No TLSA association is configured; DANE remains optional.',
					providerValues
				);
			}
			return checklistObservation(
				'dns.tlsa',
				dnsResultStatus(results.tlsa, isFinalDnsRetry),
				results.tlsa?.error ?? 'The configured TLSA association is live.',
				checkedValues(results.tlsa)
			);
		case 'domain.tracking': {
			const row = context.tracking.find(
				(candidate) =>
					candidate.domain === domain.domain || candidate.domain.endsWith(`.${domain.domain}`)
			);
			if (!row) {
				return checklistObservation(
					'dns.tracking-cname',
					'warn',
					'No tracking domain is configured.',
					providerValues
				);
			}
			try {
				const answers = (await dns.resolveCname(row.domain)).map((value) =>
					value.toLowerCase().replace(/\.$/, '')
				);
				const expected = row.cnameTarget.toLowerCase().replace(/\.$/, '');
				const pass = answers.includes(expected);
				return checklistObservation(
					'dns.tracking-cname',
					pass ? 'pass' : 'fail',
					pass
						? 'The tracking CNAME resolves to the configured Owlat endpoint.'
						: 'The tracking CNAME points somewhere else.',
					[...providerValues, ...answers.map((answer) => `observed=${answer}`)]
				);
			} catch {
				return checklistObservation(
					'dns.tracking-cname',
					pendingDnsStatus(isFinalDnsRetry),
					'The tracking CNAME is not visible yet.',
					providerValues
				);
			}
		}
		case 'domain.unsubscribe':
			try {
				assertMarketingOneClickSigningContract();
				return checklistObservation(
					'marketing-envelope.rfc8058',
					'pass',
					'The production worker gates every marketing envelope on RFC 8058 headers, and the DKIM signer covers both required headers.',
					['production-gate=worker-pre-dispatch', 'dkim-contract=rfc8058']
				);
			} catch (error) {
				return checklistObservation(
					'marketing-envelope.rfc8058',
					'fail',
					error instanceof Error ? error.message : 'The RFC 8058 envelope validator failed.'
				);
			}
		case 'domain.postmaster':
			return context.postmaster &&
				Date.now() - context.postmaster.fetchedAt <= POSTMASTER_MAX_AGE_MS
				? checklistObservation(
						'google-postmaster.ingestion',
						'pass',
						'Google Postmaster data has been ingested for this verified domain.',
						[`fetched-at=${context.postmaster.fetchedAt}`]
					)
				: checklistObservation(
						'google-postmaster.ingestion',
						'warn',
						context.postmaster
							? 'The latest Google Postmaster observation is stale.'
							: 'No Google Postmaster observation has been ingested yet.'
					);
		case 'domain.spam_rate': {
			if (
				!context.postmaster ||
				Date.now() - context.postmaster.fetchedAt > POSTMASTER_MAX_AGE_MS ||
				Date.now() - context.postmaster.periodStart > POSTMASTER_PERIOD_MAX_AGE_MS
			) {
				return checklistObservation(
					'google-postmaster.spam-rate',
					'warn',
					context.postmaster
						? 'The latest provider-observed spam rate or reporting period is stale.'
						: 'No provider-observed spam rate is available yet.'
				);
			}
			const ratio = context.postmaster.userReportedSpamRatio;
			return checklistObservation(
				'google-postmaster.spam-rate',
				ratio >= 0.003 ? 'fail' : ratio >= 0.001 ? 'warn' : 'pass',
				`Google reported ${(ratio * 100).toFixed(3)}% user spam for the latest day.`,
				[
					`spam-ratio=${ratio}`,
					`period-start=${context.postmaster.periodStart}`,
					`fetched-at=${context.postmaster.fetchedAt}`,
				]
			);
		}
		default:
			return checklistObservation('unsupported', 'fail', 'This domain validator is not available.');
	}
}
