<script setup lang="ts">
import { api } from "@owlat/api";
import type { Id } from "@owlat/api/dataModel";

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
const canLoadMoreRelayDomains = computed(() => relayDomainStatus.value === "CanLoadMore");
const { run: verifyRelayDomain } = useBackendOperation(api.domains.dnsVerification.verifyDomain, {
	label: "Verify relay domain",
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
		| undefined,
): RelayDnsRecord[] {
	return [
		...(records?.spf ? [records.spf] : []),
		...(records?.dkim ?? []),
		...(records?.mailFrom ?? []),
	];
}

async function handleVerifyRelayDomain(domainId: Id<"domains">) {
	verifyingRelayDomainId.value = domainId;
	const result = await verifyRelayDomain({ domainId });
	verifyingRelayDomainId.value = null;
	if (result !== undefined) showNotification("Relay DNS verification refreshed");
}
</script>

<template>
	<div v-if="relayDomains?.length" class="card p-6 space-y-4" data-testid="relay-domain-status">
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
