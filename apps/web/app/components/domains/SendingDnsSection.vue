<script setup lang="ts">
/**
 * The SENDING side of an expanded domain row: what the domain is for, the
 * records the operator has to publish for it (SPF, DKIM, DMARC, MAIL FROM), the
 * readiness summary derived from the verification data, the DMARC enforcement
 * selector and the return-path editor.
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
import { domainReadinessMessage } from '~/utils/domainReadiness';
import type { SpfCoexistenceSuggestion } from '~/utils/spfCoexistence';
import { normalizeDnsRecord, readinessSummary, type DmarcPolicy } from '~/utils/domainStatus';

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

// Derive once per render rather than re-running on each of the several template
// reads — rows re-render on the open-panel auto-recheck poll.
const readiness = computed(() => readinessSummary(props.domain));

/**
 * The readiness tail sentence, translated. The helper that composes it lives in
 * `~/utils/domainReadiness`; per the registry convention it hands back a message
 * key (with params when it interpolates), so the component is what resolves it.
 */
const readinessMessage = computed(() => {
	const message = domainReadinessMessage(readiness.value) as
		| string
		| { key: string; params?: Record<string, unknown> };
	return typeof message === 'string' ? t(message) : t(message.key, message.params ?? {});
});

const dmarcRecord = computed(() => normalizeDnsRecord(props.domain.dnsRecords.dmarc, 'TXT'));

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

	<!-- One-line domain readiness summary derived purely from the
	     verification data already on the domain. -->
	<div v-if="readiness.total > 0" class="flex flex-wrap items-center gap-x-3 gap-y-2 mb-4 text-sm">
		<div class="flex flex-wrap items-center gap-1.5">
			<span
				v-for="chip in readiness.chips"
				:key="chip.label"
				class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium"
				:class="
					chip.verified
						? 'bg-success/20 text-success border-success/30'
						: 'bg-error/20 text-error border-error/30'
				"
			>
				<Icon :name="chip.verified ? 'lucide:check-circle-2' : 'lucide:x-circle'" class="w-3 h-3" />
				{{ t(chip.label) }}
			</span>
		</div>
		<span :class="readiness.allVerified ? 'text-success' : 'text-text-secondary'">
			{{ readinessMessage }}
		</span>
	</div>

	<div class="space-y-4">
		<DomainsDNSRecordPanel
			v-if="normalizeDnsRecord(domain.dnsRecords.spf, 'TXT')"
			:record="normalizeDnsRecord(domain.dnsRecords.spf, 'TXT')!"
			label="SPF"
			:domain="domain.domain"
			:verification="domain.verificationResults?.spf"
			:coexistence="isExpanded ? (spfCoexistence ?? undefined) : undefined"
		/>

		<DomainsDNSRecordPanel
			v-for="(dkimRecord, i) in domain.dnsRecords.dkim"
			:key="`dkim-${i}`"
			:record="normalizeDnsRecord(dkimRecord, 'CNAME')!"
			:label="`DKIM ${i + 1}`"
			:domain="domain.domain"
			:verification="domain.verificationResults?.dkim?.[i]"
		/>

		<DomainsDNSRecordPanel
			v-if="dmarcRecord"
			:record="dmarcRecord"
			label="DMARC"
			:domain="domain.domain"
			:verification="domain.verificationResults?.dmarc"
		/>

		<!-- DMARC enforcement policy selector -->
		<div v-if="dmarcRecord" class="p-4 bg-bg-surface rounded-xl border border-border-subtle">
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

		<!-- MAIL FROM records -->
		<template v-if="domain.dnsRecords.mailFrom && domain.dnsRecords.mailFrom.length > 0">
			<div class="pt-2">
				<p
					class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-3"
					data-testid="mailfrom-heading"
				>
					{{ t('components.domains.recordRow.mailFromHeading')
					}}<template v-if="mailFromHost"> ({{ mailFromHost }})</template>
				</p>
				<div class="space-y-4">
					<DomainsDNSRecordPanel
						v-for="(mailFromRecord, i) in domain.dnsRecords.mailFrom"
						:key="`mailfrom-${i}`"
						:record="
							normalizeDnsRecord(mailFromRecord, mailFromRecord.type === 'MX' ? 'MX' : 'TXT')!
						"
						:label="mailFromRecord.type === 'MX' ? 'MAIL FROM MX' : 'MAIL FROM SPF'"
						:domain="domain.domain"
						:verification="domain.verificationResults?.mailFrom?.[i]"
					/>
				</div>

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
		</template>
	</div>
</template>
