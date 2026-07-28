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

/** Flatten the generated rows into what DNSRecordPanel renders. */
const recordPanels = computed(() =>
	(ready.value?.records ?? []).map((record, index) => ({
		key: `${record.host}-${record.purpose}-${index}`,
		label:
			record.purpose === 'dkim'
				? `DKIM (${record.arm === 'own' ? 'this server' : 'relay'})`
				: (RECORD_LABELS[record.purpose] ?? record.purpose),
		record: {
			type: record.type,
			host: record.host,
			hostIsFqdn: true,
			// A pending DKIM row carries NO value — see DNSRecordPanel.
			value:
				record.purpose === 'dkim'
					? record.key.status === 'published'
						? `v=DKIM1; k=rsa; p=${record.key.value}`
						: null
					: record.value,
			...(record.purpose === 'mx' ? { priority: record.priority } : {}),
		},
	}))
);

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
		</div>
	</section>
</template>
