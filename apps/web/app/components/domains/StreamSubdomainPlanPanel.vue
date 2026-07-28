<script setup lang="ts">
/**
 * PER-STREAM SENDING SUBDOMAINS — the wizard panel (P4-7, gap G-14).
 *
 * Domain reputation is evaluated PER FQDN and does NOT inherit from the
 * registrable root, so a bad campaign on one name can drag password resets down
 * with it. Separating `news.` from `mail.` is industry standard, and until this
 * panel the wizard neither offered nor encouraged it. The proposed layout is
 * therefore shown BY DEFAULT, not behind an expert toggle, and the
 * reputation-inheritance rule is said HERE rather than in the docs.
 *
 * Every decision rendered here is DERIVED by the backend's pure core
 * (`domains/streamSubdomains.ts`, `streamSubdomainRecords.ts`, `bimi.ts`): the
 * component recomputes nothing, so the screen can never disagree with the table
 * the operator is about to publish.
 *
 * SINGLE-IP DEPLOYMENTS ARE THE COMMON CASE. With one address the two pools are
 * the same address and the panel says so plainly — the subdomain split still
 * delivers the isolation that matters, because domain reputation is what is
 * doing the work. Nothing on this screen assumes a second IP.
 *
 * D2 — no external account is load-bearing. With zero third-party credentials
 * the table renders in full; a relay arm simply contributes no second DKIM row.
 * BIMI is an OFFER gated on the DMARC precondition — never a nag, and absent
 * entirely when the precondition does not hold.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	domainId: Id<'domains'>;
	/** Whether the current member may change domain settings. */
	canManage: boolean;
}>();

// Admin-gated on the backend, so a member who cannot manage domains must not
// subscribe at all (matches YahooCflPanel / MtaStsModeCard).
const { data: plan } = useConvexQuery(
	api.domains.streamSubdomainWizard.getStreamSubdomainPlan,
	() => (props.canManage ? { domainId: props.domainId } : 'skip')
);

const ready = computed(() => (plan.value?.ok === true ? plan.value : null));

const ROLE_LABELS: Record<string, string> = {
	transactional: 'Transactional',
	bulk: 'Marketing & lifecycle',
	bounce: 'Bounces (return path)',
};

const roleLabel = (role: string): string => ROLE_LABELS[role] ?? role;

const RECORD_LABELS: Record<string, string> = {
	spf: 'SPF',
	dkim: 'DKIM',
	dmarc: 'DMARC',
	mx: 'MX',
};

/**
 * Flatten the generated rows into what DNSRecordPanel renders.
 *
 * `value` arrives ALREADY RESOLVED from the backend (`streamSubdomainRecordValue`
 * is the one place that decides what is copyable for a row), so nothing here
 * branches on the record's purpose to build a DNS value. Two renderers of one
 * DNS value drift; this component is not the second one.
 *
 * ROWS FOR THE DOMAIN BEING VIEWED ARE DROPPED. This panel is mounted inside the
 * SAME expanded record row as that domain's shipped SPF/DKIM/DMARC panels, and
 * `mail.`/`news.` are exactly the names the Add-Domain form suggests — so the
 * host is normally one of the three proposed ones. The values are identical
 * either way (the backend builds them from the same source the provider adapter
 * does), but showing the operator the same record twice under two headings is
 * not information, it is doubt.
 */
const recordPanels = computed(() =>
	(ready.value?.records ?? [])
		.filter((record) => record.subdomain !== ready.value?.domain)
		.map((record, index) => ({
			key: `${record.host}-${record.purpose}-${index}`,
			label:
				record.purpose === 'dkim'
					? `DKIM (${record.arm === 'own' ? 'this server' : 'relay'})`
					: (RECORD_LABELS[record.purpose] ?? record.purpose),
			record: {
				type: record.type,
				host: record.host,
				hostIsFqdn: true,
				value: record.value,
				...(record.priority === undefined ? {} : { priority: record.priority }),
			},
		}))
);

const REJECTED_INPUT_LABELS: Record<string, string> = {
	logoUrl: 'MTA_BIMI_LOGO_URL',
	vmcUrl: 'MTA_BIMI_VMC_URL',
};

/** Name the value to fix rather than silently rendering nothing. */
const rejectedInputCopy = (keys: readonly string[]): string =>
	`${keys.map((key) => REJECTED_INPUT_LABELS[key] ?? key).join(' and ')} must be a plain https:// URL with no spaces or semicolons, so no BIMI record was generated.`;

/** Offers only — an ineligible domain shows nothing about BIMI at all. */
const bimiOffers = computed(() =>
	(ready.value?.bimiOffers ?? []).filter((entry) => entry.offer.offered)
);
</script>

<template>
	<section
		v-if="ready"
		class="mt-4 pt-4 border-t border-border-subtle"
		data-testid="stream-subdomain-plan"
	>
		<h4 class="text-sm font-medium text-text-primary">Recommended sending subdomains</h4>
		<p class="mt-1 text-xs text-text-secondary">
			Send each kind of mail from its own name so one bad campaign can never take your password
			resets with it.
		</p>

		<!-- The proposal — shown by default, not behind a toggle. -->
		<ul class="mt-3 space-y-2" data-testid="stream-subdomain-list">
			<li
				v-for="entry in ready.subdomains"
				:key="entry.host"
				class="rounded-lg border border-border-subtle bg-bg-surface p-3"
			>
				<div class="flex flex-wrap items-baseline gap-2">
					<code class="font-mono text-sm text-text-primary">{{ entry.host }}</code>
					<span class="text-xs text-text-tertiary">{{ roleLabel(entry.role) }}</span>
					<!-- Work already done is shown as done, never re-proposed. -->
					<span
						v-if="entry.alreadyRegistered"
						class="text-xs text-text-tertiary"
						data-testid="stream-subdomain-registered"
						>Already added</span
					>
				</div>
				<p v-if="entry.streams.length > 0" class="mt-1 text-xs text-text-secondary">
					Carries: {{ entry.streams.join(', ') }}
				</p>
			</li>
		</ul>

		<!-- The advice the card requires to live in the wizard, not the docs. The
		     copy is resolved by the backend so this component owns no wording. -->
		<ul class="mt-3 space-y-1.5" data-testid="stream-subdomain-advice">
			<li
				v-for="line in ready.advice"
				:key="line.key"
				class="flex items-start gap-2 text-xs text-text-secondary"
				:data-advice-key="line.key"
			>
				<Icon name="lucide:info" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-tertiary" />
				<span>{{ line.text }}</span>
			</li>
		</ul>

		<!-- Each new sending name warms from day one; it inherits nothing. -->
		<p
			v-if="ready.warmingPlans.length > 0"
			class="mt-3 text-xs text-text-tertiary"
			data-testid="stream-subdomain-warming"
		>
			{{ ready.warmingPlans.length }} sending name(s) each start their own warm-up from day one.
		</p>

		<!-- ONE PASS: every record for every subdomain, generated together. -->
		<div class="mt-4 space-y-3" data-testid="stream-subdomain-records">
			<DomainsDNSRecordPanel
				v-for="panel in recordPanels"
				:key="panel.key"
				:record="panel.record"
				:label="panel.label"
				:domain="ready.domain"
			/>
		</div>

		<!-- BIMI: offered only once DMARC is enforcing, and never a nag. -->
		<div
			v-for="entry in bimiOffers"
			:key="`bimi-${entry.host}`"
			class="mt-3 rounded-lg border border-border-subtle bg-bg-surface p-3"
			data-testid="stream-subdomain-bimi"
		>
			<p class="text-xs font-medium text-text-primary">
				Optional: show your logo on {{ entry.host }} (BIMI)
			</p>
			<p class="mt-1 text-xs text-text-secondary">{{ entry.offer.vmcNote }}</p>
			<!-- The record itself, once a logo URL is configured. -->
			<DomainsDNSRecordPanel
				v-if="entry.offer.record"
				class="mt-2"
				:record="{
					type: entry.offer.record.type,
					host: entry.offer.record.host,
					hostIsFqdn: true,
					value: entry.offer.record.value,
				}"
				label="BIMI"
				:domain="ready.domain"
			/>
			<!-- A value we could not publish as given: say which one, and stop.
			     Still never a blocker — BIMI is an offer (D2). -->
			<p
				v-else-if="entry.offer.rejectedInputs.length > 0"
				class="mt-2 text-xs text-text-tertiary"
				data-testid="stream-subdomain-bimi-rejected"
			>
				{{ rejectedInputCopy(entry.offer.rejectedInputs) }}
			</p>
			<p v-else class="mt-2 text-xs text-text-tertiary" data-testid="stream-subdomain-bimi-no-logo">
				Set MTA_BIMI_LOGO_URL to the HTTPS address of your SVG logo and this record is generated for
				you.
			</p>
		</div>
	</section>
</template>
