<script setup lang="ts">
/**
 * The Mailchimp Transactional sending-domain identity — the Mandrill twin of
 * `RelayDomainStatus.vue`'s SES escape-hatch panel.
 *
 * TWO things it does differently from the SES panel, both forced by how Mandrill
 * works:
 *
 *  - The records are DERIVED, not remembered. Mandrill signs every account with
 *    one shared selector, so the SPF include and the DKIM key are a function of
 *    the domain name. The query derives them from the same helper the adapter
 *    registers with, so this screen can never show DNS we did not ask Mandrill
 *    about.
 *  - There is a THIRD step beyond the two records: OWNERSHIP. A domain with
 *    perfect SPF and DKIM but no ownership proof is one Mandrill still bounces
 *    (`reject_reason: unsigned`), so it is shown as its own item rather than
 *    folded into "DNS".
 *
 * Mandrill's own error text is rendered VERBATIM. It is the authority on whether
 * the published record is the one it wants, and its sentence ("no TXT record
 * found at mandrill._domainkey") is the only actionable part.
 *
 * Renders nothing at all when no Mandrill identity exists — a deployment that
 * never connected Mandrill has no state here, and an empty card would be a
 * to-do item invented for a provider they do not use.
 */
import { api } from '@owlat/api';
import {
	mandrillOutstanding,
	mandrillRelayDisplay,
	type MandrillRelayTone,
} from '~/utils/mandrillRelayStatus';

const { data: identities } = useOrganizationQuery(api.domains.mandrillRelayQueries.listIdentities);

// Read inside the computed, not once at setup: the clock is re-read on every
// data refresh, so a page left open across a proof expiry catches up with the
// next sweep result rather than holding a stale "verified".
const rows = computed(() =>
	(identities.value ?? []).map((identity) => ({
		identity,
		display: mandrillRelayDisplay(identity, Date.now()),
		outstanding: mandrillOutstanding(identity),
		records: [
			...(identity.records.spf ? [{ ...identity.records.spf, note: 'SPF' }] : []),
			...identity.records.dkim.map((record) => ({ ...record, note: 'DKIM' })),
		],
	}))
);

const TONE_CLASS: Record<MandrillRelayTone, string> = {
	success: 'text-success',
	warning: 'text-warning',
	error: 'text-error',
	neutral: 'text-text-tertiary',
};

function formatDate(at: number | null): string {
	return at === null ? 'not scheduled' : new Date(at).toLocaleString();
}
</script>

<template>
	<div v-if="rows.length" class="card p-6 space-y-4" data-testid="mandrill-domain-status">
		<div>
			<h2 class="text-lg font-medium text-text-primary">
				Mailchimp Transactional sending domains
			</h2>
			<p class="mt-1 text-sm text-text-secondary">
				Publish these records, then complete Mandrill's own domain verification. All three have to
				be in place before Owlat will route a send for this domain through Mandrill — Mandrill
				rejects mail from a domain it has not verified, however good the DNS is.
			</p>
		</div>

		<div
			v-for="row in rows"
			:key="row.identity.domain"
			class="rounded-lg border border-border-subtle p-4 space-y-3"
			data-testid="mandrill-domain-row"
		>
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0">
					<p class="font-medium text-text-primary">{{ row.identity.domain }}</p>
					<p class="mt-0.5 text-sm text-text-secondary">{{ row.display.summary }}</p>
				</div>
				<span
					class="shrink-0 text-xs font-medium"
					:class="TONE_CLASS[row.display.tone]"
					data-testid="mandrill-domain-state"
				>
					{{ row.display.label }}
				</span>
			</div>

			<p v-if="row.outstanding.length" class="text-xs text-text-tertiary">
				Outstanding: {{ row.outstanding.join(' · ') }}
			</p>

			<!-- Mandrill's own words, unedited. -->
			<p
				v-if="row.identity.spf?.error"
				class="rounded bg-bg-surface p-3 text-xs text-text-secondary"
				data-testid="mandrill-spf-error"
			>
				SPF: {{ row.identity.spf.error }}
			</p>
			<p
				v-if="row.identity.dkim?.error"
				class="rounded bg-bg-surface p-3 text-xs text-text-secondary"
				data-testid="mandrill-dkim-error"
			>
				DKIM: {{ row.identity.dkim.error }}
			</p>
			<p
				v-if="row.identity.lastError"
				class="rounded bg-error/5 p-3 text-xs text-error"
				data-testid="mandrill-last-error"
			>
				{{ row.identity.lastError }}
			</p>

			<!-- Derived records: SPF include + the shared DKIM key. -->
			<div
				v-for="record in row.records"
				:key="`${record.note}:${record.host}`"
				class="rounded bg-bg-surface p-3 text-xs"
				data-testid="mandrill-dns-record"
			>
				<p class="text-text-tertiary">{{ record.note }} · {{ record.type }} {{ record.host }}</p>
				<code class="block mt-1 break-all text-text-primary">{{ record.value }}</code>
			</div>

			<!-- Step three: ownership. Either a TXT token Mandrill handed us, or
			     their own dashboard flow when this account offers no token. -->
			<div
				v-if="row.display.needsOwnership"
				class="rounded bg-bg-surface p-3 text-xs"
				data-testid="mandrill-ownership"
			>
				<template v-if="row.identity.records.ownership">
					<p class="text-text-tertiary">
						Ownership · {{ row.identity.records.ownership.type }}
						{{ row.identity.records.ownership.host }}
					</p>
					<code class="block mt-1 break-all text-text-primary">
						{{ row.identity.records.ownership.value }}
					</code>
				</template>
				<p v-else class="text-text-secondary">
					Ownership: this Mandrill account verifies domains from its dashboard rather than with a
					TXT record. Open Mailchimp Transactional &rarr; Settings &rarr; Domains &rarr; Sending
					Domains and complete the verification for this domain.
				</p>
			</div>

			<p class="text-xs text-text-tertiary" data-testid="mandrill-freshness">
				Last confirmed {{ formatDate(row.identity.lastCheckedAt) }} · next automatic check
				{{ formatDate(row.identity.nextCheckDueAt) }}
			</p>
		</div>
	</div>
</template>
