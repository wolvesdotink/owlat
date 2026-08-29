<script setup lang="ts">
import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import { formatDateTime } from '~/utils/formatters';
import type { SpfCoexistenceSuggestion } from '~/utils/spfCoexistence';
import {
	getStatusBadgeClass,
	getStatusIcon,
	hasDnsRecords,
	type DmarcPolicy,
} from '~/utils/domainStatus';
// Explicit import (rather than the Nuxt auto-import) so the section resolves in
// the row's own component tests, which stub only the leaf panels.
import SendingDnsSection from './SendingDnsSection.vue';

type DomainRow = FunctionReturnType<typeof api.domains.domains.listByOrganization>[number];

const props = defineProps<{
	domain: DomainRow;
	isExpanded: boolean;
	canForceVerify: boolean;
	canManageDomains: boolean;
	isForcing: boolean;
	isVerifying: boolean;
	isUpdatingDmarc: boolean;
	autoRecheckActive: boolean;
	spfCoexistence: SpfCoexistenceSuggestion | null;
	dmarcPolicyOptions: { value: DmarcPolicy; label: string; hint: string }[];
	showReceivingDns: boolean;
	inboundMailHost: string | null;
	inboundPort: number;
	inboundEnabled: boolean;
}>();

const emit = defineEmits<{
	toggle: [];
	forceVerify: [];
	verify: [];
	retryRegistration: [];
	delete: [];
	dmarcChange: [policy: DmarcPolicy];
}>();

const { t } = useI18n();

/** Status pill copy. An unmapped status falls back to the raw value, capitalized. */
const STATUS_KEYS: Record<string, string> = {
	pending: 'components.domains.recordRow.status.pending',
	verified: 'components.domains.recordRow.status.verified',
	failed: 'components.domains.recordRow.status.failed',
	registering: 'components.domains.recordRow.status.registering',
};
const statusLabel = computed(() => {
	const status = props.domain.status;
	const key = STATUS_KEYS[status];
	return key ? t(key) : status.charAt(0).toUpperCase() + status.slice(1);
});
// The return-path (bounce / MAIL FROM) host as the backend actually keyed it.
// This mirrors the verifier's host rule (dnsVerification.ts): a `hostname` is
// an absolute FQDN (the MTA return-path SPF lives on a sibling domain, e.g.
// `bounce.example.com`), whereas a `host` is relative to the From-domain — the
// SES provider emits `host: 'mail'`, which resolves to `mail.<domain>`; `@`
// means the domain apex itself. Both the collapsed "bounces via …" hint and
// the expanded MAIL FROM heading read from here so the label can never drift
// from the record — and never renders a bare relative label like "mail".
const mailFromHost = computed<string | null>(() => {
	for (const record of props.domain.dnsRecords.mailFrom ?? []) {
		if (record.hostname) return record.hostname;
		if (record.host) {
			return record.host === '@' ? props.domain.domain : `${record.host}.${props.domain.domain}`;
		}
	}
	return null;
});

// Concrete example sender address — resolves the "what is this name for?"
// ambiguity at a glance. The sending identity IS the domain string itself.
const sendsAsAddress = computed(() => `anyone@${props.domain.domain}`);

// Registration has SETTLED: the domain is no longer mid-registration and is not
// sitting on a registration failure. The registering placeholder and the
// failure notice REPLACE the setup sections rather than sitting alongside them,
// so this gates everything that only makes sense once the domain exists —
// the DNS guidance, the propagation note, and the Yahoo CFL enrollment flow
// (which is a feedback-loop wizard, not DNS guidance).
const registrationSettled = computed(
	() =>
		props.domain.status !== 'registering' &&
		!(props.domain.status === 'failed' && props.domain.lastRegistrationError)
);
</script>

<template>
	<div class="card p-0 overflow-hidden">
		<!-- Domain Header -->
		<div
			class="px-6 py-4 flex items-center justify-between cursor-pointer hover:bg-bg-surface/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
			role="button"
			tabindex="0"
			:aria-expanded="isExpanded"
			:aria-controls="`domain-records-${domain._id}`"
			:aria-label="t('components.domains.recordRow.rowLabel', { domain: domain.domain })"
			@click="emit('toggle')"
			@keydown.enter.self="emit('toggle')"
			@keydown.space.self.prevent="emit('toggle')"
		>
			<div class="flex items-center gap-4">
				<UiIconBox icon="lucide:globe" size="sm" variant="surface" rounded="lg" />
				<div>
					<div class="flex items-center gap-3">
						<p class="font-medium text-text-primary">{{ domain.domain }}</p>
						<span
							:class="[
								'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border',
								getStatusBadgeClass(domain.status),
							]"
						>
							<Icon
								:name="getStatusIcon(domain.status)"
								:class="['w-3 h-3', domain.status === 'registering' && 'animate-spin motion-reduce:animate-none']"
							/>
							{{ statusLabel }}
						</span>
					</div>
					<!-- Single identity + status hint line (§3.1 mock). Says what the
					     domain is FOR — a concrete example sender address resolves the
					     "what's this name?" ambiguity — plus the bounce host named from
					     the actual return-path record so it can't drift, then the
					     existing status / added-date info. -->
					<p class="text-sm text-text-tertiary mt-0.5" data-testid="sends-as-line">
						{{ t('components.domains.recordRow.sendsAs', { address: sendsAsAddress })
						}}<template v-if="mailFromHost">
							·
							{{ t('components.domains.recordRow.bouncesVia', { host: mailFromHost }) }}</template
						>
						·
						<span v-if="domain.status === 'registering'">
							{{ t('components.domains.recordRow.hint.registering') }}
						</span>
						<span v-else-if="domain.status === 'failed' && domain.lastRegistrationError">
							{{ t('components.domains.recordRow.hint.registrationFailed') }}
						</span>
						<span v-else-if="domain.status === 'verified'">
							{{
								t('components.domains.recordRow.hint.verified', {
									date: formatDateTime(domain.verifiedAt),
								})
							}}
						</span>
						<span v-else-if="domain.lastVerifiedAt">
							{{
								t('components.domains.recordRow.hint.lastChecked', {
									date: formatDateTime(domain.lastVerifiedAt),
								})
							}}
						</span>
						<span v-else>
							{{
								t('components.domains.recordRow.hint.added', {
									date: formatDateTime(domain.createdAt),
								})
							}}
						</span>
					</p>
				</div>
			</div>

			<div class="flex items-center gap-2">
				<UiButton
					v-if="canForceVerify && domain.status !== 'verified'"
					class="gap-1.5 text-sm py-1.5 px-3 border border-warning/40 bg-warning/10 text-warning hover:bg-warning/20"
					:title="t('components.domains.recordRow.forceVerifyTitle')"
					:disabled="isForcing"
					@click.stop="emit('forceVerify')"
				>
					<Icon v-if="isForcing" name="lucide:loader-2" class="w-4 h-4 animate-spin motion-reduce:animate-none" />
					<Icon v-else name="lucide:wand-2" class="w-4 h-4" />
					{{ t('components.domains.recordRow.forceVerify') }}
					<span
						class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-warning/20 uppercase tracking-wide"
					>
						{{ t('components.domains.recordRow.devBadge') }}
					</span>
				</UiButton>
				<UiButton
					variant="secondary"
					class="gap-1.5 text-sm py-1.5 px-3"
					:title="
						domain.status === 'registering'
							? t('components.domains.recordRow.waitingForRegistration')
							: t('components.domains.recordRow.verifyTitle')
					"
					:disabled="isVerifying || domain.status === 'registering'"
					@click.stop="
						domain.status === 'failed' && domain.lastRegistrationError
							? emit('retryRegistration')
							: emit('verify')
					"
				>
					<Icon
						v-if="isVerifying || domain.status === 'registering'"
						name="lucide:loader-2"
						class="w-4 h-4 animate-spin motion-reduce:animate-none"
					/>
					<Icon v-else name="lucide:refresh-cw" class="w-4 h-4" />
					<template v-if="domain.status === 'registering'">{{
						t('components.domains.recordRow.registering')
					}}</template>
					<template v-else-if="domain.status === 'failed' && domain.lastRegistrationError">{{
						t('common.retry')
					}}</template>
					<template v-else>{{
						isVerifying
							? t('components.domains.recordRow.verifying')
							: t('components.domains.recordRow.verify')
					}}</template>
				</UiButton>
				<UiButton
					variant="ghost"
					class="p-2 text-error hover:bg-error/10"
					:title="t('components.domains.recordRow.removeDomain')"
					:aria-label="t('components.domains.recordRow.removeDomain')"
					@click.stop="emit('delete')"
				>
					<Icon name="lucide:trash-2" class="w-4 h-4" />
				</UiButton>
				<div
					:class="[
						'w-5 h-5 flex items-center justify-center transition-transform',
						isExpanded ? 'rotate-180' : '',
					]"
				>
					<svg
						class="w-4 h-4 text-text-tertiary"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M19 9l-7 7-7-7"
						/>
					</svg>
				</div>
			</div>
		</div>

		<!-- DNS Records (Expanded) -->
		<Transition name="expand">
			<div
				v-if="isExpanded"
				:id="`domain-records-${domain._id}`"
				class="border-t border-border-subtle"
			>
				<div class="px-6 py-4 bg-bg-surface/30">
					<!-- Registering state -->
					<div
						v-if="domain.status === 'registering'"
						class="flex items-center gap-3 py-8 justify-center"
					>
						<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin motion-reduce:animate-none text-info" />
						<p class="text-sm text-text-secondary">
							{{ t('components.domains.recordRow.settingUp') }}
						</p>
					</div>

					<!-- Registration error -->
					<div v-else-if="domain.status === 'failed' && domain.lastRegistrationError" class="py-4">
						<div class="p-4 bg-error/5 border border-error/20 rounded-xl mb-4">
							<p class="text-sm text-error font-medium mb-1">
								{{ t('components.domains.recordRow.registrationFailed') }}
							</p>
							<p class="text-sm text-text-secondary">
								{{ domain.lastRegistrationError }}
							</p>
						</div>
						<UiButton class="gap-2" @click="emit('retryRegistration')">
							<Icon name="lucide:refresh-cw" class="w-4 h-4" />
							{{ t('components.domains.recordRow.retryRegistration') }}
						</UiButton>
					</div>

					<!-- DNS records (normal state): everything the operator publishes to
					     SEND from this domain. -->
					<SendingDnsSection
						v-else-if="hasDnsRecords(domain.dnsRecords)"
						:domain="domain"
						:is-expanded="isExpanded"
						:can-manage-domains="canManageDomains"
						:is-updating-dmarc="isUpdatingDmarc"
						:auto-recheck-active="autoRecheckActive"
						:spf-coexistence="spfCoexistence"
						:dmarc-policy-options="dmarcPolicyOptions"
						:mail-from-host="mailFromHost"
						@dmarc-change="emit('dmarcChange', $event)"
					/>

					<!-- Per-STREAM sending subdomains (G-14): the proposed layout, the
					     reputation-inheritance advice and every record for it in one pass. -->
					<DomainsStreamSubdomainPlanPanel
						v-if="registrationSettled"
						:domain-id="domain._id"
						:can-manage="canManageDomains"
					/>

					<!-- Yahoo's CFL is enrolled against the DKIM DOMAIN, so its guided flow
					     belongs here. Never enrolling is supported (D2); the panel owns its
					     own divider so nothing renders when it has nothing to show. -->
					<DomainsYahooCflPanel
						v-if="registrationSettled"
						:domain-id="domain._id"
						:can-manage="canManageDomains"
					/>

					<!-- Receiving (inbound MX) — renders whenever the deployment exposes a
					     mail host, whether or not inbound is enabled yet; the section
					     itself shows a "not turned on yet" state when off so setup
					     is not a chicken-and-egg. -->
					<div
						v-if="showReceivingDns && registrationSettled"
						class="mt-4 pt-4 border-t border-border-subtle"
					>
						<DomainsReceivingDnsSection
							:domain="domain.domain"
							:mail-host="inboundMailHost"
							:inbound-port="inboundPort"
							:inbound-enabled="inboundEnabled"
						/>
					</div>

					<!-- Help Text -->
					<DomainsDnsPropagationNote v-if="registrationSettled" />
				</div>
			</div>
		</Transition>
	</div>
</template>

<style scoped>
/* Expand transition */
.expand-enter-active,
.expand-leave-active {
	transition: all var(--motion-moderate) var(--ease-spring);
	overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
	opacity: 0;
	max-height: 0;
}

.expand-enter-to,
.expand-leave-from {
	max-height: 1000px;
}
</style>
