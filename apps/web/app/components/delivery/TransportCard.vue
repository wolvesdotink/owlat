<script setup lang="ts">
/**
 * The one transport card that leads the Delivery hub.
 *
 * Sending has three first-class shapes (Owlat’s own mail server, Amazon SES, or
 * a generic SMTP relay), and until now an operator had to dig through the setup
 * sub-pages to learn which one is live and whether it’s healthy. This card makes
 * that the headline: current transport, ready/not-ready state, recent health,
 * and a single "Change transport" action. Provider-routing is demoted to an
 * "Advanced routing" link at the foot — the escape hatch, not the front door.
 *
 * Non-secret by construction: it reads `getTransportSummary` (member-safe, no
 * credentials, no env-presence map). Editing the transport lives on the
 * admin-gated config page this links to, so a member can see the state without
 * being able to change it.
 */
import { api } from '@owlat/api';
import { deriveTransportDisplay, type TransportText } from '~/utils/transportState';
import { healthChipClass, healthDotClass } from '~/utils/healthTone';
import { formatCompactRelativeTime } from '~/utils/formatters';

const { t } = useI18n();

/**
 * The transport name and its one-line description come out of
 * `utils/transportState`, a module-scope definition set that carries i18n keys
 * rather than sentences (the registry convention), and a key may arrive with the
 * values its message interpolates. A plain string is still accepted so a name
 * from the catalog, the backend or an unknown `EMAIL_PROVIDER` reads as itself.
 */
function localized(value: TransportText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

const {
	data: summary,
	isLoading,
	error,
} = useOrganizationQuery(api.delivery.status.getTransportSummary);

const display = computed(() => (summary.value ? deriveTransportDisplay(summary.value) : null));

const lastCheckedLabel = computed(() => {
	const at = summary.value?.infrastructure?.observedAt ?? summary.value?.health?.lastCheckedAt;
	return at ? formatCompactRelativeTime(at) : null;
});

const infrastructureChecks = computed(() => {
	const health = summary.value?.infrastructure;
	if (!health) return [];
	return [
		{ label: t('components.delivery.transportCard.checks.queueStore'), ok: health.isRedisConnected },
		{
			label: t('components.delivery.transportCard.checks.deliveryWorker'),
			ok: health.isWorkerAlive,
		},
		{ label: t('components.delivery.transportCard.checks.dnsResolver'), ok: health.isDnsReachable },
		{
			label: t('components.delivery.transportCard.checks.outboundSmtp'),
			ok: health.smtpOutbound?.status === 'ok',
		},
	];
});
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<!-- Loading -->
		<div v-if="isLoading" class="p-6 flex items-center gap-3 text-text-tertiary">
			<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin" />
			<span class="text-sm">{{ t('components.delivery.transportCard.loading') }}</span>
		</div>

		<!-- Error (e.g. transiently unavailable) -->
		<div v-else-if="error" class="p-6 flex items-start gap-3">
			<Icon name="lucide:alert-circle" class="w-5 h-5 text-warning mt-0.5 shrink-0" />
			<p class="text-sm text-text-secondary">
				{{ t('components.delivery.transportCard.error') }}
			</p>
		</div>

		<div v-else-if="display && summary" class="p-6 space-y-5">
			<!-- Headline: transport + state chips -->
			<div class="flex items-start justify-between gap-4">
				<div class="flex items-start gap-3 min-w-0">
					<UiIconBox icon="lucide:send" size="md" variant="brand" rounded="lg" />
					<div class="min-w-0">
						<p class="text-xs font-medium uppercase tracking-wide text-text-tertiary">
							{{ t('components.delivery.transportCard.eyebrow') }}
						</p>
						<h2 class="text-lg font-semibold text-text-primary truncate">
							{{ localized(display.label) }}
						</h2>
						<p class="text-sm text-text-secondary mt-0.5">{{ localized(display.description) }}</p>
					</div>
				</div>
				<span
					class="px-2.5 py-1 rounded-full text-xs font-medium shrink-0"
					:class="healthChipClass[display.configuredTone]"
				>
					{{ t(display.configuredLabel) }}
				</span>
			</div>

			<!-- Health + last-checked line -->
			<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
				<span
					class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
					:class="healthChipClass[display.healthTone]"
				>
					<span class="w-1.5 h-1.5 rounded-full" :class="healthDotClass[display.healthTone]" />
					{{ t(display.healthLabel) }}
				</span>
				<span v-if="lastCheckedLabel" class="text-xs text-text-tertiary">
					{{ t('components.delivery.transportCard.lastChecked', { when: lastCheckedLabel }) }}
				</span>
			</div>

			<!-- Built-in MTA infrastructure signals come from the periodic /health
				 snapshot, independently of whether a recent message happened to send. -->
			<div
				v-if="infrastructureChecks.length"
				class="grid grid-cols-2 lg:grid-cols-4 gap-2 rounded-lg bg-bg-surface p-3"
			>
				<div
					v-for="check in infrastructureChecks"
					:key="check.label"
					class="flex items-center gap-2 text-xs text-text-secondary"
				>
					<span
						class="w-1.5 h-1.5 rounded-full shrink-0"
						:class="healthDotClass[check.ok ? 'success' : 'error']"
					/>
					{{ check.label }}
				</div>
			</div>

			<!-- Not-ready nudge (plain language, no lecture) -->
			<p
				v-if="!display.isConfigured"
				class="flex items-start gap-2 text-sm text-text-secondary rounded-lg bg-bg-surface px-3 py-2"
			>
				<Icon name="lucide:info" class="w-4 h-4 text-warning mt-0.5 shrink-0" />
				<span>{{ t('components.delivery.transportCard.notConfigured') }}</span>
			</p>

			<!-- Advanced-routing-in-use note -->
			<p
				v-else-if="summary.advancedRoutingActive"
				class="flex items-start gap-2 text-sm text-text-secondary rounded-lg bg-bg-surface px-3 py-2"
			>
				<Icon name="lucide:route" class="w-4 h-4 text-text-tertiary mt-0.5 shrink-0" />
				<span>{{ t('components.delivery.transportCard.advancedRoutingActive') }}</span>
			</p>

			<!-- Actions -->
			<div class="flex flex-wrap items-center gap-3 pt-1">
				<UiButton to="/dashboard/admin/delivery/transport">
					<Icon name="lucide:settings-2" class="w-4 h-4" />
					{{
						display.isConfigured
							? t('components.delivery.transportCard.changeTransport')
							: t('components.delivery.transportCard.setUpSending')
					}}
				</UiButton>
				<NuxtLink
					to="/dashboard/admin/delivery/provider-routing"
					class="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-brand transition-colors duration-(--motion-fast)"
				>
					<Icon name="lucide:route" class="w-4 h-4" />
					{{ t('components.delivery.transportCard.advancedRouting') }}
				</NuxtLink>
			</div>
		</div>
	</UiCard>
</template>
