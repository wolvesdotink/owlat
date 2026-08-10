<script setup lang="ts">
/**
 * THE relay sending-domain identity panel — for every relay kind the backend can
 * speak for, which is every kind the domain-provider registry proves.
 *
 * WHAT IT REPLACED, because the shape of this file is the fix. Until the read
 * became generic there were two panels: this one, worded for SES throughout
 * ("SES escape-hatch domains", "SES status"), because its query point-read the
 * frozen `sendingDomainSesIdentities` sibling; and `MandrillDomainStatus.vue`
 * beside it, reading a second query that filtered the shared table on
 * `providerKind === 'mandrill'`. Between them sat `ANSWERS_FOR_KINDS = ['ses']`
 * — a kind literal this component had to carry because a UI gate cannot be more
 * general than the per-vendor BACKEND READ behind it. And the bundled plugin
 * relay tier, which writes the same shared table Mandrill does, had no panel at
 * all: its operators were told provisioning was queued, forever, about a run
 * that had already finished.
 *
 * NOW EVERY STRING IS DOWNSTREAM OF A ROW. `providerRoutes.listRelayDomainIdentities`
 * walks the relay-identity registry and returns one row per (domain, relay
 * kind), each carrying its own `kindLabel` from the catalog, its records, its
 * verdicts and the freshness bound routing applies to it. So the copy is
 * general because the DATA is, not in spite of it — and a relay registered
 * tomorrow appears here with no edit to this file.
 *
 * WHEN IT RENDERS is the row set itself. The old gate had to be computed in the
 * browser (`utils/relayIdentityPanel.ts`, now gone) from a second `listRoutes`
 * subscription plus a capability lookup, because the query answered for every
 * owned domain whatever the deployment had configured. The query now answers
 * only where there is something true to say — an identity that exists, or a
 * relay this deployment has configured — so "are there rows?" is the whole gate.
 *
 * PER-KIND COPY, and only the genuinely irreducible kind, lives in
 * {@link PROVIDER_COPY} — the same pattern `SignedWebhookCard.vue` uses for the
 * feedback ceremony. A kind with no entry there renders the generic ceremony,
 * which is correct for any relay.
 */
import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	relayDomainDisplay,
	relayDomainOutstanding,
	type RelayDomainTone,
} from '~/utils/relayDomainDisplay';

/**
 * The relay identities this org holds, plus the ones its configured escape
 * hatch has yet to provision. Read here rather than passed in, because this card
 * is self-querying by design: the three pages that host it embed one tag and
 * learn nothing about what it needs.
 */
const {
	results: relayDomains,
	status: relayDomainStatus,
	loadMore: loadMoreRelayDomains,
} = usePaginatedQuery(api.providerRoutes.listRelayDomainIdentities, () => ({}), {
	initialNumItems: 100,
});
const canLoadMoreRelayDomains = computed(() => relayDomainStatus.value === 'CanLoadMore');

/** One relay's irreducibly specific instructions. */
interface RelayProviderCopy {
	/**
	 * How this provider's OWNERSHIP ceremony is completed when it issues no TXT
	 * token — a console flow we cannot describe generically, because the menu
	 * path is the actionable part.
	 */
	readonly ownershipWithoutToken?: string;
}

/**
 * PER-KIND copy, keyed by kind and colocated with the markup it feeds.
 *
 * Mandrill's entry is the only one, and it is here rather than in a panel of its
 * own for the reason the whole file exists: an account that Mandrill never
 * handed a `mandrill_verify` token to verifies from Mailchimp's dashboard, and
 * "complete this provider's verification in its console" is not enough to act
 * on. Everything else that card used to say — the derived records, the verbatim
 * error text, the ownership TXT, the freshness line — is data now, and is
 * rendered below for every kind that reports it.
 */
const PROVIDER_COPY: Readonly<Record<string, RelayProviderCopy>> = {
	mandrill: {
		ownershipWithoutToken:
			'this account verifies domains from its dashboard rather than with a TXT record. Open Mailchimp Transactional → Settings → Domains → Sending Domains and complete the verification for this domain.',
	},
};

// Read inside the computed, not once at setup: the clock is re-read on every
// data refresh, so a page left open across a proof expiry catches up with the
// next sweep result rather than holding a stale "verified".
const rows = computed(() =>
	(relayDomains.value ?? []).map((row) => ({
		row,
		display: relayDomainDisplay(row, Date.now()),
		outstanding: relayDomainOutstanding(row),
		ownershipWithoutToken:
			PROVIDER_COPY[row.kind]?.ownershipWithoutToken ??
			`complete ${row.kindLabel}'s own domain verification for this domain in its console.`,
	}))
);

const TONE_CLASS: Record<RelayDomainTone, string> = {
	success: 'text-success',
	warning: 'text-warning',
	error: 'text-error',
	neutral: 'text-text-tertiary',
};

const { run: verifyRelayDomain } = useBackendOperation(api.domains.dnsVerification.verifyDomain, {
	label: 'Verify relay domain',
});
const { showToast: showNotification } = useToast();
const verifyingRelayDomainId = ref<string | null>(null);

async function handleVerifyRelayDomain(domainId: Id<'domains'>) {
	verifyingRelayDomainId.value = domainId;
	const result = await verifyRelayDomain({ domainId });
	verifyingRelayDomainId.value = null;
	if (result !== undefined) showNotification('Relay DNS verification refreshed');
}

function formatDate(at: number | null | undefined): string {
	return at === null || at === undefined ? 'not scheduled' : new Date(at).toLocaleString();
}

/**
 * An ownership record is rendered as the step it is, not folded into "DNS": a
 * domain with perfect SPF and DKIM but no ownership proof is one the relay still
 * rejects, so it must not read as one more line in a list of records.
 *
 * Typed against the query's own row rather than a structural literal, so a
 * change to what a record carries fails here instead of rendering blanks.
 */
type RelayDomainRecord = FunctionReturnType<
	typeof api.providerRoutes.listRelayDomainIdentities
>['page'][number]['records'][number];

function publishedRecords(records: readonly RelayDomainRecord[]): RelayDomainRecord[] {
	return records.filter((record) => record.label !== 'Ownership');
}
function ownershipRecord(records: readonly RelayDomainRecord[]): RelayDomainRecord | undefined {
	return records.find((record) => record.label === 'Ownership');
}
</script>

<template>
	<div v-if="rows.length" class="card p-6 space-y-4" data-testid="relay-domain-status">
		<div>
			<h2 class="text-lg font-medium text-text-primary">Relay sending domains</h2>
			<p class="mt-1 text-sm text-text-secondary">
				Publish these records before automatic fallback can activate. A shown apex SPF value is
				authoritatively merged with the owned-MTA policy. If no SPF row is shown, preserve your
				existing SPF record and complete a reviewed additive merge; never replace it with a
				relay-only value. Your primary DMARC record remains unchanged.
			</p>
		</div>
		<div
			v-for="entry in rows"
			:key="`${entry.row.domainId}:${entry.row.kind}`"
			class="rounded-lg border border-border-subtle p-4 space-y-3"
			data-testid="relay-domain-row"
		>
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0">
					<p class="font-medium text-text-primary">{{ entry.row.domain }}</p>
					<p class="text-xs text-text-tertiary" data-testid="relay-domain-provider">
						{{ entry.row.kindLabel }}
					</p>
					<p class="mt-0.5 text-sm text-text-secondary">{{ entry.display.summary }}</p>
				</div>
				<div class="flex shrink-0 items-center gap-3">
					<span
						class="text-xs font-medium"
						:class="TONE_CLASS[entry.display.tone]"
						data-testid="relay-domain-state"
					>
						{{ entry.display.label }}
					</span>
					<UiButton
						variant="secondary"
						:loading="verifyingRelayDomainId === entry.row.domainId"
						:disabled="entry.row.records.length === 0"
						@click="handleVerifyRelayDomain(entry.row.domainId)"
					>
						Verify DNS
					</UiButton>
				</div>
			</div>

			<p v-if="entry.outstanding.length" class="text-xs text-text-tertiary">
				Outstanding: {{ entry.outstanding.join(' · ') }}
			</p>

			<!-- The provider's own words, unedited: it is the authority on whether the
			     published record is the one it wants. -->
			<p
				v-if="entry.row.spf?.error"
				class="rounded bg-bg-surface p-3 text-xs text-text-secondary"
				data-testid="relay-spf-error"
			>
				SPF: {{ entry.row.spf.error }}
			</p>
			<p
				v-if="entry.row.dkim?.error"
				class="rounded bg-bg-surface p-3 text-xs text-text-secondary"
				data-testid="relay-dkim-error"
			>
				DKIM: {{ entry.row.dkim.error }}
			</p>
			<p
				v-if="entry.row.lastError"
				class="rounded bg-error/5 p-3 text-xs text-error"
				data-testid="relay-last-error"
			>
				{{ entry.row.lastError }}
			</p>

			<p
				v-if="entry.row.spfProof === 'not_applicable_manual_primary'"
				class="rounded bg-bg-surface p-3 text-xs text-text-secondary"
				data-testid="relay-spf-not-applicable"
			>
				Apex SPF: not applicable to this relay's proof. Keep the reviewed manual primary SPF
				policy; {{ entry.row.kindLabel }} is authenticated by its verified DKIM and its own
				return-path records.
			</p>

			<div
				v-for="record in publishedRecords(entry.row.records)"
				:key="`${record.label}:${record.host}:${record.value}`"
				class="rounded bg-bg-surface p-3 text-xs"
				data-testid="relay-dns-record"
			>
				<p class="text-text-tertiary">
					{{ record.label }}<span v-if="record.type"> · {{ record.type }}</span>
					{{ record.host }}<span v-if="record.priority"> priority {{ record.priority }}</span>
				</p>
				<code class="block mt-1 break-all text-text-primary">{{ record.value }}</code>
			</div>

			<!-- Ownership: its own step, because a domain with perfect SPF and DKIM
			     and no ownership proof is one the relay still rejects. Either a token
			     the provider issued, or its own console flow when it issues none. -->
			<div
				v-if="entry.display.needsOwnership"
				class="rounded bg-bg-surface p-3 text-xs"
				data-testid="relay-ownership"
			>
				<template v-if="ownershipRecord(entry.row.records)">
					<p class="text-text-tertiary">
						Ownership · {{ ownershipRecord(entry.row.records)?.type }}
						{{ ownershipRecord(entry.row.records)?.host }}
					</p>
					<code class="block mt-1 break-all text-text-primary">
						{{ ownershipRecord(entry.row.records)?.value }}
					</code>
				</template>
				<p v-else class="text-text-secondary">Ownership: {{ entry.ownershipWithoutToken }}</p>
			</div>

			<p
				v-if="entry.row.lastCheckedAt"
				class="text-xs text-text-tertiary"
				data-testid="relay-freshness"
			>
				Last confirmed {{ formatDate(entry.row.lastCheckedAt) }} · next automatic check
				{{ formatDate(entry.row.nextCheckDueAt) }}
			</p>
		</div>
		<div
			v-if="canLoadMoreRelayDomains"
			class="flex justify-center border-t border-border-subtle pt-4"
		>
			<UiButton variant="secondary" @click="loadMoreRelayDomains(100)">Load more domains</UiButton>
		</div>
	</div>
</template>
