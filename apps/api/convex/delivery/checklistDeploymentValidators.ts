'use node';

import {
	SES_RELAY_PROOF_MAX_AGE_MS,
	serializeDeliverabilityObservation,
	type DeliverabilityCheckId,
} from '@owlat/shared';
import {
	isFallbackRelayEligible,
	routeCarriesEnabledRelay,
	routeCarriesOwnArm,
} from '../lib/sendProviders/fallbackEligibility';
import { detectIpProvider } from './checklistProviderDetection';
import { checklistTraits } from './checklistTraits';
import {
	checklistObservation,
	pendingDnsStatus,
	RELAY_IDENTITY_PROOF_KIND,
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
			// ASK THE CAPABILITY, don't name the provider. This used to require
			// `relayProviderType === 'ses'` and an enabled `'ses'` route entry, which
			// was true of the gate above it at the time — `setRoute` refused any other
			// relay. Since P0.2 it does not, so a deployment relaying through
			// Mandrill (or a bring-your-own SMTP relay) had a fallback configured,
			// identities provisioned and a checklist item that said "No verified relay
			// fallback is configured" forever.
			//
			// EVERY condition asked of the module that owns it, AND against the same
			// evidence, so that "is this route a working fallback?" has one answer
			// here and at save time. `isFallbackRelayEligible` is the predicate
			// `setRoute` and `resolveRoute` gate on and the two route-shape
			// preconditions are the same two functions `setRoute` throws on. Between
			// them they keep the row's free-form `relayProviderType` from crediting
			// the OWN MTA (which a fallback moves traffic away from, never to), a
			// retired kind, or a relay that is not a live arm of the route at all.
			//
			// READINESS, NOT ENV PRESENCE, and injected rather than read here.
			// `isFallbackRelayEligible` takes its configured-ness from the caller
			// precisely so the two askers cannot disagree; `setRoute` hands it
			// `isSendProviderReady`, which for a plugin transport also resolves the
			// mutable `send:transport` grant. This validator runs in the Node runtime
			// with no `ctx`, so `delivery/checklist.ts` resolves that same predicate
			// where a `ctx` exists and projects the answer onto the context. Reading
			// `providerKindConfigured` here instead would agree with the mutation on
			// every core kind and disagree on exactly the tier where it matters: a
			// bundled plugin relay whose grant was revoked keeps its env vars, so
			// `resolveRoute` stops using it as the fallback while this item goes on
			// reporting the fallback relay ready.
			const readyRelayKinds = context.readyRelayKinds ?? [];
			const readyFallbackKinds = context.routes.flatMap((route) => {
				const fallback = route.deliverabilityFallback;
				if (fallback?.isEnabled !== true) return [];
				const configured =
					isFallbackRelayEligible(fallback.relayProviderType, (kind) =>
						readyRelayKinds.includes(kind)
					) &&
					routeCarriesEnabledRelay(route.providers, fallback.relayProviderType) &&
					routeCarriesOwnArm(route.providers);
				return configured ? [fallback.relayProviderType] : [];
			});
			const routeReady = readyFallbackKinds.length > 0;
			// STILL SES-SHAPED, and deliberately left so by the leak sweep: the
			// identity half reads `context.relayIdentities`, which the verification
			// context types as rows of the FROZEN `sendingDomainSesIdentities`
			// sibling. Widening it to the generic `sendingDomainRelayIdentities`
			// table is the same read `providerRoutes.listDeliverabilityRelayDomains`
			// has to grow (the two carry different per-kind identity shapes and have
			// to move together — see the sending-domain section of
			// `docs/abstractions.md`).
			//
			// SO THE TWO HALVES ARE HELD TOGETHER RATHER THAN LEFT TO DRIFT. Those
			// rows prove ONE kind's identities ({@link RELAY_IDENTITY_PROOF_KIND}),
			// and a deployment that switches its fallback to another relay KEEPS
			// them: nothing deletes the SES siblings on a switch and `verifyDomain`
			// goes on refreshing them, so a proof read that ignored which kind is
			// configured would report a relay holding zero identities as fully
			// proven — a false green exactly where the operator is asking whether
			// the fallback will work. Until the generic read lands, a relay whose
			// proofs this deployment cannot see reaches "the route is configured,
			// the proof is absent", which is both true and the same warn a missing
			// SES proof gets.
			//
			// EVERY configured relay, not merely one of them: a deployment can route
			// its message types to different fallbacks, and a proof that covers one
			// of them says nothing about the other. `every` fails closed on the
			// mixed configuration; `some` would report the whole item green on the
			// strength of the one relay this deployment can still read proofs for.
			const identitiesReady =
				readyFallbackKinds.every((kind) => kind === RELAY_IDENTITY_PROOF_KIND) &&
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
				// The validator ID is a STABLE KEY, not a description: it is serialized
				// into the evidence stored against past checklist runs, so renaming it
				// would orphan that history for a deployment's own audit trail. The
				// copy below is what an operator reads, and that no longer names a
				// provider (the same call P0.2 made for the routing error copy).
				'provider-route.ses-relay-readiness',
				pass ? 'pass' : 'warn',
				pass
					? 'The deliverability fallback relay is enabled and every relay identity has a current provider and SPF proof.'
					: routeReady
						? 'The deliverability fallback relay is enabled, but at least one domain proof is absent or stale.'
						: 'No verified relay fallback is configured.',
				// THE EVIDENCE SAYS WHOSE PROOF IT IS. These rows are always the one
				// kind's frozen siblings, and a deployment that switched its fallback
				// keeps them — so on a Mandrill route the unqualified list read
				// "at least one domain proof is absent or stale" beside
				// `provider-verified=true` for every domain, which is the same false
				// green the `every(kind === RELAY_IDENTITY_PROOF_KIND)` gate above
				// exists to prevent, re-appearing in the record an operator opens to
				// understand the warn. The two leading facts name the proof's kind and
				// the configured relay's, so a stored observation is self-explaining
				// even when the rows and the route disagree.
				[
					`proof-kind=${RELAY_IDENTITY_PROOF_KIND}`,
					`configured-relay=${readyFallbackKinds.join(',') || 'none'}`,
					...context.relayIdentities.flatMap((identity) => [
						`domain-id=${identity.domainId}`,
						`provider-verified=${identity.isProviderVerified}`,
						`verified-at=${identity.verifiedAt ?? 'missing'}`,
					]),
				]
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
