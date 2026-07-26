'use node';

import dns from 'node:dns/promises';
import { createPublicKey } from 'node:crypto';
import { verifyMtaStsPublication, type DeliverabilityCheckId } from '@owlat/shared';
import type { ActionCtx } from '../_generated/server';
import { api } from '../_generated/api';
import { runDnsLookups } from '../domains/dnsVerification';
import { fetchMtaStsPolicyBody, resolveMtaStsTxt } from '../domains/mtaStsVerify';
import { resolveSesMailFrom } from '../domains/providers/ses/mailFrom';
import { getOptional } from '../lib/env';
import { assertMarketingOneClickSigningContract } from './marketingCompliance';
import { detectDomainDnsProvider, dnsProviderObservation } from './checklistProviderDetection';
import { checklistTraits } from './checklistTraits';
import { absoluteDnsRecordName, hardenedSpfRecordValue } from './checklistRecords';
import {
	dnsBundleObservations,
	dnsBundleStatus,
	dnsRecordObservation,
	dnsResultStatus,
	isSuccessfulDnsResult,
} from './checklistDnsObservations';
import {
	checklistObservation,
	pendingDnsStatus,
	type ChecklistObservation,
	type ChecklistVerificationContext,
} from './checklistValidatorTypes';

const POSTMASTER_MAX_AGE_MS = 48 * 60 * 60 * 1_000;
const POSTMASTER_PERIOD_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1_000;
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

function hasStrictSpfPolicy(value: string | undefined): boolean {
	const terms = value?.trim().split(/\s+/) ?? [];
	return terms[terms.length - 1]?.toLowerCase() === '-all';
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
	const traits = checklistTraits(itemId);
	const providerValues = traits.needsDnsProvider
		? dnsProviderObservation(await detectDomainDnsProvider(domain.domain))
		: [];
	const dnsRecords =
		itemId === 'domain.spf' && domain.dnsRecords.spf
			? {
					...domain.dnsRecords,
					spf: {
						...domain.dnsRecords.spf,
						value: hardenedSpfRecordValue(domain.dnsRecords.spf.value),
					},
				}
			: domain.dnsRecords;
	const results = traits.needsDomainDnsBundle
		? await runDnsLookups(domain.domain, dnsRecords)
		: null;

	switch (itemId) {
		case 'domain.spf': {
			if (!results) throw new Error('SPF DNS observation was not loaded');
			const observedPolicy = results.spf?.foundValue ?? domain.dnsRecords.spf?.value;
			const isStrict = hasStrictSpfPolicy(observedPolicy);
			const status = isSuccessfulDnsResult(results.spf)
				? isStrict
					? 'pass'
					: pendingDnsStatus(isFinalDnsRetry)
				: dnsResultStatus(results.spf, isFinalDnsRetry);
			return checklistObservation(
				'dns.spf',
				status,
				isSuccessfulDnsResult(results.spf) && !isStrict
					? 'SPF is published, but it must end in -all for this checklist.'
					: (results.spf?.error ?? 'SPF is live and ends in -all.'),
				[...providerValues, dnsRecordObservation('spf', domain.domain, dnsRecords.spf, results.spf)]
			);
		}
		case 'domain.dkim': {
			if (!results) throw new Error('DKIM DNS observation was not loaded');
			const configured = domain.dnsRecords.dkim ?? [];
			const verified =
				results.dkim?.length === configured.length &&
				configured.length > 0 &&
				results.dkim.every((result) => isSuccessfulDnsResult(result));
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
						: pendingDnsStatus(isFinalDnsRetry)
				: dnsBundleStatus(results.dkim, isFinalDnsRetry, configured.length);
			return checklistObservation(
				'dns.dkim',
				status,
				verified && hasProviderManagedCname && !strong
					? 'The provider-managed DKIM CNAME is live, but key strength needs message-level proof.'
					: verified && !strong
						? 'The live DKIM key is shorter than 2048 bits or could not be parsed.'
						: (results.dkim?.find((result) => result.error)?.error ??
							'Every DKIM selector is live with a 2048-bit-or-stronger key.'),
				[
					...providerValues,
					...dnsBundleObservations('dkim', domain.domain, configured, results.dkim),
					...keyBits.map((bits) => `key-bits=${bits ?? 'unknown'}`),
				]
			);
		}
		case 'domain.dmarc': {
			if (!results) throw new Error('DMARC DNS observation was not loaded');
			const authenticationReady =
				isSuccessfulDnsResult(results.spf) &&
				(domain.dnsRecords.dkim?.length ?? 0) > 0 &&
				results.dkim?.length === (domain.dnsRecords.dkim?.length ?? 0) &&
				results.dkim?.every((result) => isSuccessfulDnsResult(result)) === true;
			const pass = isSuccessfulDnsResult(results.dmarc) && authenticationReady;
			const authenticationInputsPresent =
				results.spf !== undefined && (results.dkim?.length ?? 0) > 0;
			const authenticationStatus = authenticationInputsPresent
				? dnsBundleStatus(
						[...(results.spf ? [results.spf] : []), ...(results.dkim ?? [])],
						isFinalDnsRetry,
						1 + (domain.dnsRecords.dkim?.length ?? 0)
					)
				: pendingDnsStatus(isFinalDnsRetry);
			return checklistObservation(
				'dns.dmarc-alignment',
				pass
					? 'pass'
					: isSuccessfulDnsResult(results.dmarc)
						? authenticationStatus
						: dnsResultStatus(results.dmarc, isFinalDnsRetry),
				pass
					? 'DMARC is live and the domain has verified SPF and DKIM alignment evidence.'
					: (results.dmarc?.error ?? 'DMARC or its authentication dependencies are missing.'),
				[
					...providerValues,
					dnsRecordObservation('spf', domain.domain, dnsRecords.spf, results.spf),
					...dnsBundleObservations(
						'dkim',
						domain.domain,
						domain.dnsRecords.dkim ?? [],
						results.dkim
					),
					dnsRecordObservation('dmarc', domain.domain, dnsRecords.dmarc, results.dmarc),
				]
			);
		}
		case 'domain.return_path': {
			if (!results) throw new Error('return-path DNS observation was not loaded');
			const mailFromRecords = domain.dnsRecords.mailFrom ?? [];
			const configuredReturnPath = domain.returnPathHost?.toLowerCase().replace(/\.$/, '');
			const activeReturnPath =
				domain.providerType === 'mta'
					? (configuredReturnPath ??
						getOptional('MTA_RETURN_PATH_DOMAIN')?.trim().toLowerCase().replace(/\.$/, ''))
					: domain.providerType === 'ses'
						? (resolveSesMailFrom(domain.domain, configuredReturnPath)?.mailFromDomain ?? null)
						: null;
			const hasActiveContract =
				activeReturnPath !== null &&
				activeReturnPath !== undefined &&
				mailFromRecords.length > 0 &&
				mailFromRecords.every(
					(record) => absoluteDnsRecordName(record, domain.domain) === activeReturnPath
				);
			const dnsPublished =
				Boolean(results.mailFrom?.length) &&
				results.mailFrom?.length === mailFromRecords.length &&
				results.mailFrom?.every((result) => result.verified) === true;
			const dnsVerified =
				dnsPublished && results.mailFrom?.every((result) => !result.error) === true;
			const providerSyncReady = domain.returnPathHostSyncError === undefined;
			const pass = hasActiveContract && dnsVerified && providerSyncReady;
			const diagnostic = !providerSyncReady
				? `The return-path host is not active at the sending provider: ${domain.returnPathHostSyncError}`
				: !hasActiveContract
					? 'The configured records do not match the active provider return-path contract.'
					: results.mailFrom?.find((result) => result.error)?.error;
			return checklistObservation(
				'dns.return-path',
				pass
					? 'pass'
					: !hasActiveContract || !providerSyncReady
						? 'fail'
						: dnsBundleStatus(results.mailFrom, isFinalDnsRetry, mailFromRecords.length),
				pass
					? 'The configured return-path host and every required DNS record are live.'
					: (diagnostic ?? 'No verified per-domain return path is available.'),
				[
					...providerValues,
					...(domain.returnPathHost ? [`return-path=${domain.returnPathHost}`] : []),
					...dnsBundleObservations('return-path', domain.domain, mailFromRecords, results.mailFrom),
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
				[
					...providerValues,
					`mta-sts-txt=expected:${verification.expectedId};observed:${verification.observedId ?? 'missing'};valid:${verification.txtRecordValid}`,
					`mta-sts-policy=served-valid:${verification.policyServedValid}`,
				]
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
				[
					...providerValues,
					dnsRecordObservation('tls-rpt', domain.domain, domain.dnsRecords.tlsRpt, results.tlsRpt),
				]
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
				[
					...providerValues,
					dnsRecordObservation(
						'tlsa',
						domain.domain,
						domain.dnsRecords.tlsa ??
							(domain.dnsRecords.tlsRpt?.type === 'TLSA' ? domain.dnsRecords.tlsRpt : undefined),
						results.tlsa
					),
				]
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
				const checkedAt = Date.now();
				const answers = (await dns.resolveCname(row.domain)).map((value) =>
					value.toLowerCase().replace(/\.$/, '')
				);
				const expected = row.cnameTarget.toLowerCase().replace(/\.$/, '');
				const pass = answers.includes(expected);
				return checklistObservation(
					'dns.tracking-cname',
					pass ? 'pass' : pendingDnsStatus(isFinalDnsRetry),
					pass
						? 'The tracking CNAME resolves to the configured Owlat endpoint.'
						: 'The tracking CNAME points somewhere else.',
					[
						...providerValues,
						dnsRecordObservation(
							'tracking',
							domain.domain,
							{ type: 'CNAME', hostname: row.domain, value: expected },
							{
								verified: pass,
								foundValue: answers.join(',') || undefined,
								...(pass ? {} : { error: 'The CNAME points somewhere else.' }),
								lastChecked: checkedAt,
							}
						),
					]
				);
			} catch (error) {
				const checkedAt = Date.now();
				return checklistObservation(
					'dns.tracking-cname',
					pendingDnsStatus(isFinalDnsRetry),
					'The tracking CNAME is not visible yet.',
					[
						...providerValues,
						dnsRecordObservation(
							'tracking',
							domain.domain,
							{ type: 'CNAME', hostname: row.domain, value: row.cnameTarget },
							{
								verified: false,
								error: error instanceof Error ? error.message : 'lookup failed',
								lastChecked: checkedAt,
							}
						),
					]
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
