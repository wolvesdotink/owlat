<script setup lang="ts">
import { formatDateTime } from '~/utils/formatters';
import type {
	DeliverabilityAlertChannels,
	DeliverabilityAlertOperation,
	DeliverabilityChecklistGroup,
	DeliverabilityRegressionAlert,
} from '~/utils/deliverabilityCenter';
import { findDeliverabilityItem } from '~/utils/deliverabilityCenter';
import { useDeliverabilityChecklistCopy } from '~/composables/useDeliverabilityChecklistCopy';
import { ArrowRightIcon, SirenIcon } from '@coolicons/vue';

const props = defineProps<{
	alerts: DeliverabilityRegressionAlert[];
	groups: DeliverabilityChecklistGroup[];
	activeOperation?: DeliverabilityAlertOperation | null;
}>();

const emit = defineEmits<{
	view: [alert: DeliverabilityRegressionAlert];
	acknowledge: [alert: DeliverabilityRegressionAlert];
	resolve: [alert: DeliverabilityRegressionAlert];
}>();

const { t } = useI18n();
/**
 * The named check is shared-registry English (the alert's own message, stored
 * and mailed, is English for the same reason), so the heading resolves the
 * catalog copy from the check id. See `~/composables/useDeliverabilityChecklistCopy`.
 */
const { itemIdTitle } = useDeliverabilityChecklistCopy();

const rows = computed(() =>
	props.alerts.map((alert) => ({
		alert,
		item: findDeliverabilityItem(props.groups, alert),
	}))
);

const C = 'components.delivery.deliverabilityRegressionAlerts.channels';

/**
 * One line naming every channel that carried the alert. The email part never
 * reads as delivered when the alert is about the server the email leaves from.
 */
function channelSummary(channels: DeliverabilityAlertChannels): string {
	const { email, inAppCount, push } = channels;
	const parts = [
		email.state === 'sent'
			? t(email.isOnAffectedTransport ? `${C}.emailOnAffectedServer` : `${C}.emailSent`)
			: t(email.state === 'pending' ? `${C}.emailPending` : `${C}.emailNotSent`),
	];
	if (inAppCount === 0) parts.push(t(`${C}.inAppNobody`));
	else if (inAppCount !== null) parts.push(t(`${C}.inApp`, inAppCount));
	if (push.delivered > 0) parts.push(t(`${C}.push`, push.delivered));
	if (push.held > 0) parts.push(t(`${C}.pushHeld`, push.held));
	if (push.failed > 0) parts.push(t(`${C}.pushFailed`, push.failed));
	return parts.join(' · ');
}

function isBusy(alert: DeliverabilityRegressionAlert, kind: DeliverabilityAlertOperation['kind']) {
	return props.activeOperation?.alertId === alert.id && props.activeOperation.kind === kind;
}
</script>

<template>
	<section
		v-if="rows.length"
		class="overflow-hidden rounded-xl border border-error/35 bg-error/5"
		aria-labelledby="deliverability-alerts-heading"
	>
		<header class="flex items-start gap-3 border-b border-error/20 px-5 py-4 sm:px-6">
			<UiIconBox :icon="SirenIcon" size="sm" variant="error" rounded="lg" />
			<div>
				<!-- The live region is the count only: on the whole section every re-render
     would re-read every alert. -->
				<h2
					id="deliverability-alerts-heading"
					class="font-semibold text-text-primary"
					aria-live="polite"
				>
					{{ t('components.delivery.deliverabilityRegressionAlerts.heading', rows.length) }}
				</h2>
				<p class="mt-0.5 text-sm text-text-secondary">
					{{ t('components.delivery.deliverabilityRegressionAlerts.subheading') }}
				</p>
			</div>
		</header>

		<div class="divide-y divide-error/15">
			<article
				v-for="{ alert, item } in rows"
				:key="alert.id"
				class="space-y-3 px-5 py-4 sm:px-6"
				:aria-labelledby="`deliverability-alert-${alert.id}`"
			>
				<div>
					<h3 :id="`deliverability-alert-${alert.id}`" class="font-medium text-text-primary">
						{{ itemIdTitle(alert.itemId, item?.title ?? alert.itemId) }}
					</h3>
					<p class="mt-1 text-sm leading-6 text-text-secondary">{{ alert.message }}</p>
				</div>

				<dl class="flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-tertiary">
					<div v-if="alert.domain" class="flex gap-1">
						<dt>{{ t('components.delivery.deliverabilityRegressionAlerts.domain') }}</dt>
						<dd class="font-medium text-text-secondary">{{ alert.domain }}</dd>
					</div>
					<div class="flex gap-1">
						<dt>{{ t('components.delivery.deliverabilityRegressionAlerts.detected') }}</dt>
						<dd>
							<time :datetime="new Date(alert.observedAt).toISOString()">
								{{ formatDateTime(alert.observedAt) }}
							</time>
						</dd>
					</div>
					<div v-if="alert.acknowledgedAt" class="flex gap-1">
						<dt>{{ t('components.delivery.deliverabilityRegressionAlerts.statusLabel') }}</dt>
						<dd>{{ t('components.delivery.deliverabilityRegressionAlerts.acknowledged') }}</dd>
					</div>
					<div class="flex gap-1">
						<dt>{{ t(`${C}.label`) }}</dt>
						<dd data-testid="alert-channels">{{ channelSummary(alert.channels) }}</dd>
					</div>
				</dl>
				<p
					v-if="alert.channels.email.isOnAffectedTransport"
					class="text-xs text-warning"
					data-testid="alert-email-may-not-arrive"
				>
					{{ t(`${C}.mayNotArrive`) }}
				</p>

				<div class="flex flex-wrap items-center gap-2">
					<UiButton size="sm" variant="secondary" @click="emit('view', alert)">
						<template #iconLeft>
							<ArrowRightIcon class="h-3.5 w-3.5" />
						</template>
						{{ t('components.delivery.deliverabilityRegressionAlerts.openCheck') }}
					</UiButton>
					<UiButton
						v-if="!alert.acknowledgedAt"
						size="sm"
						variant="ghost"
						:loading="isBusy(alert, 'acknowledge')"
						:disabled="!!activeOperation"
						@click="emit('acknowledge', alert)"
					>
						{{ t('components.delivery.deliverabilityRegressionAlerts.acknowledge') }}
					</UiButton>
					<UiButton
						size="sm"
						variant="ghost"
						:loading="isBusy(alert, 'resolve')"
						:disabled="!!activeOperation"
						@click="emit('resolve', alert)"
					>
						{{ t('components.delivery.deliverabilityRegressionAlerts.resolve') }}
					</UiButton>
				</div>
			</article>
		</div>
	</section>
</template>
