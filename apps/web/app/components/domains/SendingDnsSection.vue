<script setup lang="ts">
/**
 * The SENDING side of an expanded domain row: what the domain is for, the
 * records the operator has to publish for it as one checklist — a summary that
 * names each record still missing, then the records grouped into sender
 * authentication (SPF, DKIM, DMARC) and bounce handling (MAIL FROM) — plus the
 * DMARC enforcement selector, where the domain's DMARC reports go, and the
 * return-path editor.
 *
 * Extracted from `RecordRow.vue`, which carries the collapsed header, the
 * registering/failed states and the receiving (inbound MX) section and was over
 * the ~500-LOC cap. The split is along the same seam as the sibling
 * `ReceivingDnsSection.vue`: that one is everything you publish to RECEIVE mail,
 * this one is everything you publish to SEND it. The row still decides WHETHER
 * to show this (it renders only once the domain has DNS records); this decides
 * WHAT it says. Pinned by `__tests__/recordRowIdentity.test.ts` (intro + MAIL
 * FROM heading) and `__tests__/returnPathUi.test.ts` (zone-framed heading).
 */
import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import { trySplitZone } from '@owlat/shared';
import {
	buildSendingChecklist,
	summarizeChecklist,
	type ChecklistEntry,
} from '~/utils/dnsRecordChecklist';
import type { SpfCoexistenceSuggestion } from '~/utils/spfCoexistence';
import type { DmarcPolicy } from '~/utils/domainStatus';
// Explicit imports (rather than Nuxt auto-imports) so the section renders its
// groups in the row's component tests, which stub only the leaf panels.
import DnsChecklistSummary from './DnsChecklistSummary.vue';
import DnsRecordGroup from './DnsRecordGroup.vue';

type DomainRow = FunctionReturnType<typeof api.domains.domains.listByOrganization>[number];

const props = defineProps<{
	domain: DomainRow;
	isExpanded: boolean;
	canManageDomains: boolean;
	isUpdatingDmarc: boolean;
	autoRecheckActive: boolean;
	spfCoexistence: SpfCoexistenceSuggestion | null;
	dmarcPolicyOptions: { value: DmarcPolicy; label: string; hint: string }[];
	/**
	 * The return-path (bounce) host as the backend keyed it, resolved by the row
	 * so the collapsed "bounces via …" hint and the MAIL FROM heading here can
	 * never name different hosts.
	 */
	mailFromHost: string | null;
}>();

const emit = defineEmits<{
	dmarcChange: [policy: DmarcPolicy];
}>();

const { t } = useI18n();

// Every record as one checklist — rows, group counts and the summary's links
// all read this list. Derived once per render: rows re-render on the open-panel
// auto-recheck poll.
const checklist = computed(() => buildSendingChecklist(props.domain));
const authentication = computed(() =>
	checklist.value.filter((entry) => entry.group === 'authentication')
);
const returnPath = computed(() => checklist.value.filter((entry) => entry.group === 'returnPath'));
const authSummary = computed(() => summarizeChecklist(authentication.value));
const returnPathSummary = computed(() => summarizeChecklist(returnPath.value));
const hasDmarc = computed(() => checklist.value.some((entry) => entry.id === 'dmarc'));

const anchorFor = (entry: ChecklistEntry) => `dns-${props.domain._id}-${entry.id}`;

// When the domain already publishes a foreign SPF record, the merged record is
// what to publish — so it is also what "copy missing records" hands over.
const valueOverrides = computed<Partial<Record<string, string>>>(() =>
	props.isExpanded && props.spfCoexistence ? { spf: props.spfCoexistence.merged } : {}
);
// A zone import ADDS records, so the merged SPF line alone would sit next to the
// existing `v=spf1` — two SPF records fail SPF for all of the domain's mail. The
// copied text says, right above the line, that it replaces the old record.
const zoneNotes = computed<Partial<Record<string, string>>>(() =>
	props.isExpanded && props.spfCoexistence
		? { spf: t('components.domains.dnsChecklistSummary.zoneNoteReplaceSpf') }
		: {}
);

// The registrable zone the records actually go in — the DNS provider that
// manages this name (A1 PSL split; fail-soft to the raw domain in self-host dev
// where a name has no registrable zone). Used for both the C1 zone-framed
// config heading AND the "won't affect your website at X" intro copy, so the
// two can never disagree (they did while the intro used a hand-rolled slice:
// `example.co.uk` named the public suffix `co.uk`; `a.b.example.com` named
// `b.example.com`).
const registrableZone = computed(
	() => trySplitZone(props.domain.domain)?.registrable ?? props.domain.domain
);

// The current return-path host to seed the editor: the explicit per-domain host
// if set, otherwise the one derived from the MAIL FROM record.
const returnPathHost = computed(() => props.domain.returnPathHost ?? props.mailFromHost);
</script>

<template>
	<!-- What this domain does: an up-front job description for the
	     records below. The "not a website / won't affect your site"
	     sentence is load-bearing copy — it defuses the #1 concern
	     (that this name needs hosting or breaks the apex website). -->
	<div
		class="mb-4 p-4 bg-bg-surface rounded-xl border border-border-subtle"
		data-testid="domain-intro"
	>
		<I18nT
			keypath="components.domains.recordRow.intro.body"
			tag="p"
			scope="global"
			class="text-sm text-text-secondary"
		>
			<template #headline>
				<strong class="text-text-primary">
					{{ t('components.domains.recordRow.intro.headline') }}
				</strong>
			</template>
			<template #address>
				<span class="text-text-primary">name@{{ domain.domain }}</span>
			</template>
			<template #zone>{{ registrableZone }}</template>
		</I18nT>
	</div>

	<div class="flex items-center justify-between gap-3 mb-4">
		<I18nT
			keypath="components.domains.recordRow.configureHeading"
			tag="h4"
			scope="global"
			class="text-sm font-medium text-text-primary"
		>
			<template #zone>
				<strong data-testid="config-zone">{{ registrableZone }}</strong>
			</template>
		</I18nT>
		<!-- Subtle auto-recheck indicator: we quietly re-verify while
		     this panel is open so the user needn't keep clicking Verify. -->
		<span
			v-if="autoRecheckActive && isExpanded"
			class="inline-flex items-center gap-1.5 text-xs text-text-secondary whitespace-nowrap"
			:title="t('components.domains.recordRow.autoRecheckTitle')"
		>
			<Icon name="lucide:loader-2" class="w-3 h-3 animate-spin motion-reduce:animate-none" />
			{{ t('components.domains.recordRow.checkingDns') }}
		</span>
	</div>

	<!-- How far along the setup is, a link to each record still outstanding, and
	     one copy for exactly those records. -->
	<DnsChecklistSummary
		:entries="checklist"
		:domain="domain.domain"
		:anchor-for="anchorFor"
		:value-overrides="valueOverrides"
		:notes="zoneNotes"
	/>

	<div class="space-y-6">
		<!-- Sender authentication: who may send as this domain (SPF, DKIM) and
		     what receivers do when a message fails (DMARC). -->
		<div v-if="authentication.length > 0">
			<DnsRecordGroup
				:title="t('components.domains.sendingDnsSection.authentication.title')"
				:description="t('components.domains.sendingDnsSection.authentication.description')"
				:verified="authSummary.verified"
				:total="authSummary.total"
				:checked="authSummary.checked"
			>
				<DomainsDNSRecordPanel
					v-for="entry in authentication"
					:key="entry.id"
					:anchor-id="anchorFor(entry)"
					:record="entry.record"
					:label="entry.label"
					:domain="domain.domain"
					:verification="entry.verification"
					:coexistence="
						entry.id === 'spf' && isExpanded ? (spfCoexistence ?? undefined) : undefined
					"
				/>
			</DnsRecordGroup>

			<!-- DMARC enforcement policy selector -->
			<div v-if="hasDmarc" class="mt-3 p-4 bg-bg-surface rounded-xl border border-border-subtle">
				<label
					:for="`dmarc-policy-${domain._id}`"
					class="block text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2"
				>
					{{ t('components.domains.recordRow.dmarcPolicyLabel') }}
				</label>
				<div class="flex items-center gap-3">
					<select
						:id="`dmarc-policy-${domain._id}`"
						class="input flex-1"
						:value="domain.dmarcPolicy ?? 'none'"
						:disabled="!canManageDomains || isUpdatingDmarc"
						@change="emit('dmarcChange', ($event.target as HTMLSelectElement).value as DmarcPolicy)"
					>
						<option v-for="opt in dmarcPolicyOptions" :key="opt.value" :value="opt.value">
							{{ opt.label }}
						</option>
					</select>
					<Icon
						v-if="isUpdatingDmarc"
						name="lucide:loader-2"
						class="w-4 h-4 animate-spin motion-reduce:animate-none text-text-tertiary"
					/>
				</div>
				<p class="mt-2 text-xs text-text-secondary">
					{{ dmarcPolicyOptions.find((o) => o.value === (domain.dmarcPolicy ?? 'none'))?.hint }}
					{{ t('components.domains.recordRow.dmarcPolicyHelp') }}
				</p>
			</div>

			<!-- Where the domain's DMARC aggregate reports go, and whether the
			     record above asks for them yet. -->
			<DomainsDmarcReportingPanel
				v-if="hasDmarc"
				:domain-id="domain._id"
				:domain="domain.domain"
				:dmarc-policy="domain.dmarcPolicy"
				:dmarc-subdomain-policy="domain.dmarcSubdomainPolicy"
				:dmarc-pct="domain.dmarcPct"
				:can-manage="canManageDomains"
			/>
		</div>

		<!-- Bounce handling: the MAIL FROM (return-path) records. -->
		<div v-if="returnPath.length > 0">
			<DnsRecordGroup
				:description="t('components.domains.sendingDnsSection.returnPath.description')"
				:verified="returnPathSummary.verified"
				:total="returnPathSummary.total"
				:checked="returnPathSummary.checked"
			>
				<template #title>
					<span data-testid="mailfrom-heading"
						>{{ t('components.domains.recordRow.mailFromHeading')
						}}<template v-if="mailFromHost"> ({{ mailFromHost }})</template></span
					>
				</template>
				<DomainsDNSRecordPanel
					v-for="entry in returnPath"
					:key="entry.id"
					:anchor-id="anchorFor(entry)"
					:record="entry.record"
					:label="entry.label"
					:domain="domain.domain"
					:verification="entry.verification"
				/>
			</DnsRecordGroup>

			<!-- Change the per-domain return-path (bounce) host. Re-verifies
			     the domain; surfaces the MTA-sync-failure marker. -->
			<div class="mt-4">
				<DomainsReturnPathEditor
					:domain-id="domain._id"
					:current-host="returnPathHost"
					:zone="registrableZone"
					:sync-error="domain.returnPathHostSyncError ?? null"
					:can-manage="canManageDomains"
				/>
			</div>
		</div>
	</div>
</template>
