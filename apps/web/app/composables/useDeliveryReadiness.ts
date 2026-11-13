/**
 * The live sources behind the delivery-readiness verdicts, folded through the
 * pure `utils/deliveryReadiness` module.
 *
 * Shared by the Delivery hub's readiness panel and the compact transactional
 * line on the transactional pages, so both say the same thing. Every query is
 * member-readable except the two admin-only sources (the MTA-STS guidance and
 * the deliverability checklist), which are subscribed only for viewers who may
 * read them; a member simply gets no gate from them, never an "unknown" one.
 *
 * `scope: 'transactional'` skips the marketing-only sources (today's capacity
 * and the checklist), for surfaces that only show the transactional verdict.
 */
import { api } from '@owlat/api';
import {
	deriveDeliveryReadiness,
	readinessInputFromSources,
	type ReadinessAlignmentSource,
	type ReadinessMtaStsSource,
	type ReadinessStreamSources,
} from '~/utils/deliveryReadiness';

export function useDeliveryReadiness(options: { scope?: 'all' | 'transactional' } = {}) {
	const isFullScope = (options.scope ?? 'all') === 'all';
	const { canManageOrganization } = usePermissions();
	const { isEnabled, isLoading: flagsLoading } = useFeatureFlag();

	const {
		data: transport,
		isLoading: transportLoading,
		error: transportError,
		refetch: refetchTransport,
	} = useOrganizationQuery(api.delivery.status.getTransportSummary);

	const {
		data: domainRows,
		isLoading: domainsLoading,
		error: domainsError,
		refetch: refetchDomains,
	} = useOrganizationQuery(api.analytics.reputationQueries.getDeliveryDomainTable);

	// Warm-up state (sending IPs, halted warm-up) and the rolling complaint rate.
	const { data: sendingOverview, isLoading: overviewLoading } = useOrganizationQuery(
		api.analytics.reputationQueries.getSendingOverview
	);

	// Today's campaign capacity, under the same projection the send gate uses.
	const { data: sendingReadiness, isLoading: capacityLoading } = useOrganizationQuery(
		api.campaigns.sendingReadiness.getSendingReadiness,
		() => (isFullScope ? {} : undefined)
	);

	// The checklist's one-click unsubscribe check is admin-only (`getCenter`
	// requires `organization:manage`), so only admins subscribe.
	const { data: checklist, isLoading: checklistLoading } = useConvexQuery(
		api.delivery.checklist.getCenter,
		() => (isFullScope && canManageOrganization.value ? {} : 'skip')
	);

	// MTA-STS publishing is an admin-gated inbound-TLS concern; `getMtaStsGuidance`
	// requires `organization:manage`, so subscribe only for admins. A member can't
	// fix an inbound-TLS record anyway, and the readiness input treats a `null`
	// source as "no warning".
	const { data: mtaStsGuidance } = useConvexQuery(api.domains.mtaSts.getMtaStsGuidance, () =>
		canManageOrganization.value ? {} : 'skip'
	);

	// The domain whose published MTA-STS records we verify: the most-active verified
	// sending domain (the one readiness already reports auth against), falling back
	// to the most-active configured domain.
	const primaryDomain = computed<string | null>(() => {
		const rows = domainRows.value ?? [];
		return rows.find((row) => row.status === 'verified')?.domain ?? rows[0]?.domain ?? null;
	});

	// Live verify of the published policy vs what we serve. Admin-gated + fail-soft
	// (never throws); the shared composable runs it once `enforce` is published and
	// a domain is available, so deployments not enforcing make no backend call.
	const { verification: mtaStsVerification } = useMtaStsVerification(() =>
		canManageOrganization.value && mtaStsGuidance.value?.mode === 'enforce'
			? primaryDomain.value
			: null
	);

	// Only claim "enforce without record" once the mode is known AND we have a
	// verdict; before the verify resolves (or for a non-admin) leave it null so the
	// gate never flashes an unconfirmed warning.
	const mtaStsSource = computed<ReadinessMtaStsSource | null>(() => {
		const mode = mtaStsGuidance.value?.mode;
		if (!mode) return null;
		if (mode !== 'enforce') return { mode, recordVerified: true };
		if (!mtaStsVerification.value) return null;
		return { mode, recordVerified: mtaStsVerification.value.verified };
	});

	// The active transport's outbound identities (non-secret) + the VERIFIED sending
	// domains — the ones mail actually sends from — so the alignment gate warns only
	// when a domain you really send from is misaligned.
	const alignmentSource = computed<ReadinessAlignmentSource | null>(() => {
		const summary = transport.value;
		if (!summary) return null;
		const fromDomains = (domainRows.value ?? [])
			.filter((row) => row.status === 'verified')
			.map((row) => row.domain);
		return { facts: summary.alignment, fromDomains };
	});

	// The dual-transport ramp's alignment pre-flight: one non-secret row per
	// sending domain. Only `single_arm` rows (or none) mean "nothing to say".
	const { data: dualArmRows } = useOrganizationQuery(
		api.delivery.alignmentPreflight.getAlignmentReadiness
	);

	/**
	 * The checklist's verdict for the primary domain. An item with no evidence
	 * has never been checked, and a stale pass is not a failure, so only a
	 * checked `pass` or `fail` becomes a gate.
	 */
	const oneClickUnsubscribe = computed<'pass' | 'fail' | null>(() => {
		const domain = primaryDomain.value;
		if (!checklist.value || domain === null) return null;
		const item = checklist.value.groups
			.flatMap((group) => group.items)
			.find(
				(candidate) =>
					candidate.id === 'domain.unsubscribe' &&
					candidate.scope.kind === 'domain' &&
					candidate.scope.domain === domain
			);
		if (!item || item.lastCheckedAt === undefined) return null;
		return item.status === 'pass' ? 'pass' : item.status === 'fail' ? 'fail' : null;
	});

	const streamSources = computed<ReadinessStreamSources | null>(() => {
		const summary = transport.value;
		if (!summary) return null;
		const overview = sendingOverview.value;
		return {
			streams: summary.streams,
			mailServer: summary.mailServer,
			transactionalSender: summary.transactionalSender,
			enabled: {
				transactional: isEnabled('transactional'),
				marketing: isFullScope && isEnabled('campaigns'),
			},
			warming: overview?.warming ?? null,
			sendingReadiness: sendingReadiness.value ?? null,
			reputation: overview?.reputation ?? null,
			oneClickUnsubscribe: oneClickUnsubscribe.value,
		};
	});

	// Optional sources still count as loading, so a verdict never flips from
	// "Ready" to "Blocked" a moment after it first renders. Their errors do not
	// fail the panel: a source that could not be read gives no gate.
	const isLoading = computed(
		() =>
			transportLoading.value ||
			domainsLoading.value ||
			overviewLoading.value ||
			flagsLoading.value ||
			(isFullScope && capacityLoading.value) ||
			(isFullScope && canManageOrganization.value && checklistLoading.value)
	);
	const error = computed(() => transportError.value ?? domainsError.value ?? null);

	function retry() {
		if (transportError.value) refetchTransport();
		if (domainsError.value) refetchDomains();
	}

	const readiness = computed(() => {
		const summary = transport.value;
		if (!summary) return null;
		return deriveDeliveryReadiness(
			readinessInputFromSources(
				summary,
				domainRows.value ?? [],
				mtaStsSource.value,
				alignmentSource.value,
				dualArmRows.value ?? null,
				streamSources.value
			)
		);
	});

	return { readiness, isLoading, error, retry };
}
