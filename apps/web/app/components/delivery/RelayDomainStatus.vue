<script setup lang="ts">
/**
 * The SES escape-hatch relay's per-domain identity panel.
 *
 * WHY THIS ONE IS STILL NAMED AFTER A VENDOR, when the rest of the delivery UI
 * stopped being (the seams plan's D5). Every string here is downstream of the
 * QUERY, and `providerRoutes.listDeliverabilityRelayDomains` reads the frozen
 * `sendingDomainSesIdentities` sibling table directly — the SES proof, its DKIM
 * tokens, its dedicated MAIL FROM records and its `spfProofState`. A relay of
 * another kind never appears in these rows: Mandrill's identities land in the
 * generic `sendingDomainRelayIdentities` table and are rendered by
 * `MandrillDomainStatus.vue` beside this card, and a `domainVerification: 'none'`
 * relay has no identity to show at all.
 *
 * So renaming the copy to "your relay" would be the WRONG generalisation — it
 * would claim to cover relays whose rows this panel cannot see. What makes it
 * generic is a BACKEND change: one query over `sendingDomainRelayIdentities`
 * answering for whichever kinds the domain-provider registry can prove, at which
 * point this card and its Mandrill sibling collapse into one that names the
 * relay from its catalog label. That belongs to the registry work, not to a
 * rendering refactor, and it is recorded with that owner in
 * `scripts/provider-identity-allowlist.txt` rather than left as a note here.
 *
 * WHAT DID CHANGE HERE, because it needed no backend: WHEN the card renders.
 * The query answers for every owned sending domain, so a deployment sending
 * through Resend (or an SMTP relay, or Mandrill, or nothing but its own MTA) saw
 * this SES card telling it to wait for a provisioning run that would never
 * start. The gate is now the data itself plus the capability of the kind THIS
 * QUERY ANSWERS FOR, in `~/utils/relayIdentityPanel` — so published identity
 * state stays visible even after the fallback is switched off, and a
 * Mandrill-only deployment (a second `api` relay, with its own panel beside
 * this one) is not shown an SES provisioning run it never asked for.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { relayIdentityPanelVisible } from '~/utils/relayIdentityPanel';

/**
 * THE KINDS THIS CARD CAN SPEAK FOR — one, and it is a literal on purpose.
 *
 * Not a capability question but a DATA question: `listDeliverabilityRelayDomains`
 * reads the frozen `sendingDomainSesIdentities` table, so `ses` is the only kind
 * whose rows can appear above. It is written here, next to the query that makes
 * it true, rather than inferred from the copy — and it becomes the set of kinds
 * the generic `sendingDomainRelayIdentities` read can prove when that lands.
 */
const ANSWERS_FOR_KINDS = ['ses'] as const;

/**
 * The relays this org has configured as a deliverability escape hatch, enabled
 * or not — publishing a relay's DNS is what an operator does BEFORE switching
 * the hatch on. Read here rather than passed in, because this card is
 * self-querying by design (the `MandrillDomainStatus.vue` precedent): the page
 * embeds it as one tag and learns nothing about what it needs.
 */
const { data: routes } = useOrganizationQuery(api.providerRoutes.listRoutes);
const configuredRelayKinds = computed(() => [
	...new Set(
		(routes.value ?? []).flatMap((route) =>
			route.deliverabilityFallback ? [route.deliverabilityFallback.relayProviderType] : []
		)
	),
]);

interface RelayDnsRecord {
	type?: string;
	host?: string;
	hostname?: string;
	value: string;
	priority?: number;
}

const {
	results: relayDomains,
	status: relayDomainStatus,
	loadMore: loadMoreRelayDomains,
} = usePaginatedQuery(api.providerRoutes.listDeliverabilityRelayDomains, () => ({}), {
	initialNumItems: 100,
});
const canLoadMoreRelayDomains = computed(() => relayDomainStatus.value === 'CanLoadMore');
const isVisible = computed(() =>
	relayIdentityPanelVisible(relayDomains.value, configuredRelayKinds.value, ANSWERS_FOR_KINDS)
);
const { run: verifyRelayDomain } = useBackendOperation(api.domains.dnsVerification.verifyDomain, {
	label: 'Verify relay domain',
});
const { showToast: showNotification } = useToast();
const verifyingRelayDomainId = ref<string | null>(null);

function relayRecords(
	records:
		| {
				spf?: RelayDnsRecord;
				dkim?: RelayDnsRecord[];
				mailFrom?: RelayDnsRecord[];
		  }
		| null
		| undefined
): RelayDnsRecord[] {
	return [
		...(records?.spf ? [records.spf] : []),
		...(records?.dkim ?? []),
		...(records?.mailFrom ?? []),
	];
}

async function handleVerifyRelayDomain(domainId: Id<'domains'>) {
	verifyingRelayDomainId.value = domainId;
	const result = await verifyRelayDomain({ domainId });
	verifyingRelayDomainId.value = null;
	if (result !== undefined) showNotification('Relay DNS verification refreshed');
}
</script>

<template>
	<div v-if="isVisible" class="card p-6 space-y-4" data-testid="relay-domain-status">
		<div>
			<h2 class="text-lg font-medium text-text-primary">SES escape-hatch domains</h2>
			<p class="mt-1 text-sm text-text-secondary">
				Publish these records before automatic fallback can activate. A shown apex SPF value is
				authoritatively merged with the owned-MTA policy. If no SPF row is shown, preserve your
				existing SPF record and complete a reviewed additive merge; never replace it with an
				SES-only value. Your primary DMARC record remains unchanged.
			</p>
		</div>
		<div
			v-for="domain in relayDomains"
			:key="domain.domainId"
			class="rounded-lg border border-border-subtle p-4 space-y-3"
		>
			<div class="flex items-center justify-between gap-3">
				<div>
					<p class="font-medium text-text-primary">{{ domain.domain }}</p>
					<p class="text-xs text-text-tertiary">SES status: {{ domain.status }}</p>
				</div>
				<UiButton
					variant="secondary"
					:loading="verifyingRelayDomainId === domain.domainId"
					:disabled="!domain.dnsRecords"
					@click="handleVerifyRelayDomain(domain.domainId)"
				>
					Verify DNS
				</UiButton>
			</div>
			<p
				v-if="domain.status === 'awaiting_primary_verification'"
				class="text-sm text-text-secondary"
			>
				Verify the primary owned-MTA domain first; SES relay provisioning starts afterward.
			</p>
			<p v-else-if="!domain.dnsRecords" class="text-sm text-text-secondary">
				Provisioning is queued. Refresh shortly to see the DNS plan.
			</p>
			<div v-else class="space-y-2">
				<p
					v-if="domain.spfProofState === 'not_applicable_manual_primary'"
					class="rounded bg-bg-surface p-3 text-xs text-text-secondary"
					data-testid="relay-spf-not-applicable"
				>
					Apex SPF: not applicable to SES relay proof. Keep the reviewed manual primary SPF policy;
					SES is authenticated by its verified DKIM and dedicated MAIL FROM records.
				</p>
				<div
					v-for="record in relayRecords(domain.dnsRecords)"
					:key="`${record.type}:${record.host ?? record.hostname}:${record.value}`"
					class="rounded bg-bg-surface p-3 text-xs"
				>
					<p class="text-text-tertiary">
						{{ record.type }} {{ record.host ?? record.hostname
						}}<span v-if="record.priority"> priority {{ record.priority }}</span>
					</p>
					<code class="block mt-1 break-all text-text-primary">{{ record.value }}</code>
				</div>
			</div>
		</div>
		<div
			v-if="canLoadMoreRelayDomains"
			class="flex justify-center border-t border-border-subtle pt-4"
		>
			<UiButton variant="secondary" @click="loadMoreRelayDomains(100)">Load more domains</UiButton>
		</div>
	</div>
</template>
