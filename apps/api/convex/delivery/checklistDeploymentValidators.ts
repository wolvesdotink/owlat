'use node';

import {
	SES_RELAY_PROOF_MAX_AGE_MS,
	serializeDeliverabilityObservation,
	type DeliverabilityCheckId,
} from '@owlat/shared';
import { detectIpProvider } from './checklistProviderDetection';
import { checklistTraits } from './checklistTraits';
import {
	checklistObservation,
	pendingDnsStatus,
	type ChecklistObservation,
	type ChecklistVerificationContext,
} from './checklistValidatorTypes';

function boundedIdentityField(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	const marker = `…[length=${value.length}]`;
	return `${value.slice(0, Math.max(0, maxLength - marker.length))}${marker}`;
}

function identityObservations(
	addresses: NonNullable<ChecklistVerificationContext['warming']>['ips'],
	providers: readonly (string | null)[] = []
): string[] {
	return addresses.slice(0, 20).map((entry, index) => {
		const identity = entry.fcrdns;
		return serializeDeliverabilityObservation({
			kind: 'outbound_identity',
			ip: boundedIdentityField(entry.ip, 64),
			provider: boundedIdentityField(providers[index] ?? 'unknown', 32),
			ptrNames: (identity?.ptrNames ?? [])
				.slice(0, 4)
				.map((name) => boundedIdentityField(name, 40)),
			ehlo: boundedIdentityField(identity?.ehlo ?? 'missing', 64),
			reason: boundedIdentityField(identity?.reason ?? 'none', 96),
			checkedAt: identity?.checkedAt ?? 'missing',
		});
	});
}

function identityMismatchDiagnostic(
	addresses: NonNullable<ChecklistVerificationContext['warming']>['ips'],
	fallback: string
): string {
	const mismatch = addresses.find((entry) => entry.fcrdns?.isForwardConfirmed !== true);
	if (!mismatch?.fcrdns) return fallback;
	return `${fallback} ${mismatch.ip}: PTR ${mismatch.fcrdns.ptrNames.slice(0, 4).join(', ') || 'missing'}; EHLO ${mismatch.fcrdns.ehlo}; reason ${mismatch.fcrdns.reason ?? 'forward confirmation mismatch'}; checked ${mismatch.fcrdns.checkedAt}.`.slice(
		0,
		2_048
	);
}

export async function observeDeploymentCheck(
	itemId: DeliverabilityCheckId,
	context: ChecklistVerificationContext,
	isFinalDnsRetry: boolean
): Promise<ChecklistObservation> {
	const ips = context.warming?.ips ?? [];
	const ipv4 = ips.filter((entry) => !entry.ip.includes(':'));
	const ipv6 = ips.filter((entry) => entry.ip.includes(':'));
	const traits = checklistTraits(itemId);
	const selectedAddresses =
		traits.addressFamily === 'ipv6' ? ipv6 : traits.addressFamily === 'ipv4' ? ipv4 : ips;
	const needsVpsProvider = traits.providerGuidance?.startsWith('vps_') === true;
	const detectedProviders = needsVpsProvider
		? await Promise.all(selectedAddresses.map((entry) => detectIpProvider(entry.ip)))
		: [];
	const commonProvider =
		detectedProviders.length > 0 &&
		detectedProviders[0] !== null &&
		detectedProviders.every((candidate) => candidate === detectedProviders[0])
			? detectedProviders[0]
			: null;
	const providerSummaryValues = needsVpsProvider
		? commonProvider
			? [`vps-provider=${commonProvider}`]
			: ['vps-provider=mixed-or-unknown']
		: [];
	const observedIps = selectedAddresses.map((entry) => `ip=${entry.ip}`);
	const now = Date.now();
	const warmingFresh = context.warming !== null && now - context.warming.syncedAt <= 10 * 60_000;
	const identityFresh =
		warmingFresh &&
		selectedAddresses.every(
			(entry) => entry.fcrdns !== undefined && now - entry.fcrdns.checkedAt <= 15 * 60_000
		);
	const mtaHealthFresh =
		context.settings?.mtaHealth !== undefined &&
		now - context.settings.mtaHealth.observedAt <= 5 * 60_000;
	const staleIdentity = 'The MTA identity snapshot is missing or too old to verify this check.';
	const staleHealth = 'The MTA health snapshot is missing or too old to verify this check.';
	const dnsblFresh =
		warmingFresh &&
		selectedAddresses.length > 0 &&
		selectedAddresses.every(
			(entry) => entry.dnsblCheckedAt !== undefined && now - entry.dnsblCheckedAt <= 30 * 60_000
		);

	switch (itemId) {
		case 'deployment.ptr': {
			const pass =
				identityFresh &&
				selectedAddresses.length > 0 &&
				selectedAddresses.every((entry) => entry.fcrdns?.isPtrPresent);
			return checklistObservation(
				'mta.fcrdns',
				pass ? 'pass' : identityFresh ? pendingDnsStatus(isFinalDnsRetry) : 'warn',
				pass
					? 'Every outbound IPv4 address has a PTR record.'
					: identityFresh
						? 'An outbound address has no PTR record.'
						: staleIdentity,
				[...providerSummaryValues, ...identityObservations(selectedAddresses, detectedProviders)]
			);
		}
		case 'deployment.fcrdns': {
			const pass =
				identityFresh &&
				selectedAddresses.length > 0 &&
				selectedAddresses.every((entry) => entry.fcrdns?.isForwardConfirmed);
			return checklistObservation(
				'mta.fcrdns',
				pass ? 'pass' : identityFresh ? pendingDnsStatus(isFinalDnsRetry) : 'warn',
				pass
					? 'Every PTR hostname resolves back to its sending address.'
					: identityFresh
						? identityMismatchDiagnostic(
								selectedAddresses,
								'Forward DNS does not resolve back to the sending address.'
							)
						: staleIdentity,
				[...providerSummaryValues, ...identityObservations(selectedAddresses, detectedProviders)]
			);
		}
		case 'deployment.ptr_nongeneric': {
			const pass =
				identityFresh &&
				selectedAddresses.length > 0 &&
				selectedAddresses.every((entry) => entry.fcrdns?.isGenericPtr === false);
			return checklistObservation(
				'mta.fcrdns-generic-patterns',
				pass ? 'pass' : 'warn',
				pass
					? 'No outbound PTR matches a provider-default pattern.'
					: identityFresh
						? 'An outbound PTR is provider-generic.'
						: staleIdentity,
				[...providerSummaryValues, ...identityObservations(selectedAddresses, detectedProviders)]
			);
		}
		case 'deployment.ehlo_ptr': {
			const pass =
				identityFresh &&
				selectedAddresses.length > 0 &&
				selectedAddresses.every((entry) => entry.fcrdns?.isEhloMatched);
			return checklistObservation(
				'mta.ehlo-ptr',
				pass ? 'pass' : identityFresh ? 'fail' : 'warn',
				pass
					? 'Every outbound EHLO matches its PTR.'
					: identityFresh
						? 'An outbound EHLO does not match its PTR.'
						: staleIdentity,
				identityObservations(selectedAddresses)
			);
		}
		case 'deployment.port25': {
			const probe = context.settings?.mtaHealth?.smtpOutbound;
			const probeFresh =
				mtaHealthFresh && probe !== undefined && now - probe.checkedAt <= 5 * 60_000;
			const selectedIpSet = new Set(selectedAddresses.map((entry) => entry.ip));
			const selectedProbeAddresses =
				probe?.ips.filter((entry) => !entry.ip.includes(':') && selectedIpSet.has(entry.ip)) ?? [];
			const pass =
				probeFresh &&
				selectedAddresses.length > 0 &&
				selectedProbeAddresses.length === selectedAddresses.length &&
				selectedProbeAddresses.every((entry) => entry.status === 'ok');
			return checklistObservation(
				'mta.smtp-reachability',
				pass ? 'pass' : probeFresh ? 'fail' : 'warn',
				pass
					? 'Every configured source address reached a recipient MX on port 25.'
					: probeFresh
						? 'The live port-25 probe failed for at least one source address.'
						: staleHealth,
				selectedProbeAddresses.map((entry) => `${entry.ip}=${entry.status}`)
			);
		}
		case 'deployment.tls': {
			const tls = context.settings?.mtaHealth?.smtpTls;
			const tlsFresh = mtaHealthFresh && tls !== undefined && now - tls.checkedAt <= 5 * 60_000;
			return checklistObservation(
				'mta.smtp-tls-certificate',
				tlsFresh ? (tls?.status ?? 'fail') : 'warn',
				tlsFresh && tls
					? (tls.reason ?? 'The STARTTLS certificate is valid for the SMTP hostname.')
					: staleHealth,
				tls ? [`hostname=${tls.hostname}`, ...(tls.validTo ? [`valid-to=${tls.validTo}`] : [])] : []
			);
		}
		case 'deployment.dnsbl': {
			const pass = dnsblFresh && selectedAddresses.every((entry) => entry.dnsbl === 'clean');
			const status = !dnsblFresh
				? 'warn'
				: pass
					? 'pass'
					: selectedAddresses.some((entry) => entry.dnsbl === 'unknown')
						? 'warn'
						: 'fail';
			return checklistObservation(
				'mta.dnsbl',
				status,
				pass
					? 'Every outbound address is clean on the monitored DNS blocklists.'
					: dnsblFresh
						? 'At least one outbound address is listed or has unknown standing.'
						: 'The MTA blocklist snapshot is missing or too old to verify this check.',
				selectedAddresses.flatMap((entry) => [
					`${entry.ip}=${entry.dnsbl ?? 'unknown'}`,
					`${entry.ip}:checked-at=${entry.dnsblCheckedAt ?? 'missing'}`,
				])
			);
		}
		case 'deployment.warmup':
			return context.warming && warmingFresh
				? checklistObservation(
						'mta.warming',
						context.warming.phase === 'graduated' ? 'pass' : 'warn',
						`Warm-up is ${context.warming.phase}; ${context.warming.totalSentToday}/${context.warming.totalDailyCap} sent today.`,
						[`phase=${context.warming.phase}`, `synced-at=${context.warming.syncedAt}`]
					)
				: checklistObservation('mta.warming', 'warn', 'No warming state has been synced yet.');
		case 'deployment.relay': {
			const routeReady = context.routes.some((route) => {
				const fallback = route.deliverabilityFallback;
				return (
					fallback?.isEnabled === true &&
					fallback.relayProviderType === 'ses' &&
					route.providers.some(
						(candidate) => candidate.providerType === 'ses' && candidate.isEnabled
					)
				);
			});
			const identitiesReady =
				context.relayIdentities.length > 0 &&
				context.relayIdentities.every(
					(identity) =>
						identity.isProviderVerified &&
						identity.verifiedAt !== undefined &&
						now - identity.verifiedAt <= SES_RELAY_PROOF_MAX_AGE_MS &&
						(identity.spfProofState === 'not_applicable_manual_primary' ||
							identity.verificationResults?.spf?.verified === true)
				);
			const pass = routeReady && identitiesReady;
			return checklistObservation(
				'provider-route.ses-relay-readiness',
				pass ? 'pass' : 'warn',
				pass
					? 'The SES fallback route is enabled and every relay identity has a current provider and SPF proof.'
					: routeReady
						? 'The SES fallback route is enabled, but at least one domain proof is absent or stale.'
						: 'No verified relay fallback is configured.',
				context.relayIdentities.flatMap((identity) => [
					`domain-id=${identity.domainId}`,
					`provider-verified=${identity.isProviderVerified}`,
					`verified-at=${identity.verifiedAt ?? 'missing'}`,
				])
			);
		}
		case 'deployment.ipv6_address':
			return checklistObservation(
				'mta.ipv6-pool',
				warmingFresh && ipv6.length > 0 ? 'pass' : 'warn',
				ipv6.length > 0
					? 'An IPv6 address is configured.'
					: warmingFresh
						? 'IPv6 remains disabled, which is a safe default.'
						: staleIdentity,
				ipv6.map((entry) => `ip=${entry.ip}`)
			);
		case 'deployment.ipv6_source': {
			const pass =
				warmingFresh &&
				ipv6.length > 0 &&
				ipv6.every(
					(entry) =>
						entry.sourceAddress?.verdict === 'pass' &&
						now - entry.sourceAddress.checkedAt <= 15 * 60_000
				);
			return checklistObservation(
				'mta.ipv6-source-address',
				pass ? 'pass' : warmingFresh ? 'fail' : 'warn',
				pass
					? 'Every IPv6 source-address probe used the configured address.'
					: warmingFresh
						? 'IPv6 source binding is not verified.'
						: staleIdentity,
				observedIps
			);
		}
		case 'deployment.ipv6_ptr': {
			const pass =
				identityFresh && ipv6.length > 0 && ipv6.every((entry) => entry.fcrdns?.isPtrPresent);
			return checklistObservation(
				'mta.ipv6-fcrdns',
				pass ? 'pass' : identityFresh ? pendingDnsStatus(isFinalDnsRetry) : 'warn',
				pass
					? 'Every IPv6 sender has a PTR.'
					: identityFresh
						? 'An IPv6 sender has no PTR.'
						: staleIdentity,
				[...providerSummaryValues, ...identityObservations(selectedAddresses, detectedProviders)]
			);
		}
		case 'deployment.ipv6_aaaa': {
			const pass =
				identityFresh && ipv6.length > 0 && ipv6.every((entry) => entry.fcrdns?.isForwardConfirmed);
			return checklistObservation(
				'mta.ipv6-fcrdns',
				pass ? 'pass' : identityFresh ? pendingDnsStatus(isFinalDnsRetry) : 'warn',
				pass
					? 'Every IPv6 PTR hostname resolves back through AAAA.'
					: identityFresh
						? identityMismatchDiagnostic(
								selectedAddresses,
								'IPv6 AAAA forward confirmation failed.'
							)
						: staleIdentity,
				identityObservations(selectedAddresses)
			);
		}
		case 'deployment.ipv6_spf': {
			const pass =
				warmingFresh &&
				ipv6.length > 0 &&
				ipv6.every(
					(entry) =>
						entry.ipv6Spf?.verdict === 'pass' && now - entry.ipv6Spf.checkedAt <= 15 * 60_000
				);
			return checklistObservation(
				'mta.ipv6-spf',
				pass ? 'pass' : warmingFresh ? pendingDnsStatus(isFinalDnsRetry) : 'warn',
				pass
					? 'Every IPv6 address has an exact ip6 SPF mechanism.'
					: warmingFresh
						? 'Exact IPv6 SPF authorization is missing.'
						: staleIdentity,
				observedIps
			);
		}
		case 'deployment.ipv6_pool': {
			const pass =
				warmingFresh &&
				ipv6.length > 0 &&
				ipv6.every((entry) => entry.active && (entry.blockReasons?.length ?? 0) === 0);
			return checklistObservation(
				'mta.ipv6-pool-readiness',
				pass ? 'pass' : warmingFresh ? 'fail' : 'warn',
				pass
					? 'The IPv6 pool is active with no readiness block.'
					: warmingFresh
						? 'The IPv6 pool remains locked by a prerequisite.'
						: staleIdentity,
				observedIps
			);
		}
		default:
			return checklistObservation(
				'unsupported',
				'fail',
				'This deployment validator is not available.'
			);
	}
}
