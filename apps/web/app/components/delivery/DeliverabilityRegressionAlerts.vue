<script setup lang="ts">
import { formatDateTime } from "~/utils/formatters";
import type {
	DeliverabilityAlertOperation,
	DeliverabilityChecklistGroup,
	DeliverabilityRegressionAlert,
} from "~/utils/deliverabilityCenter";
import { findDeliverabilityItem } from "~/utils/deliverabilityCenter";

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

const rows = computed(() =>
	props.alerts.map((alert) => ({
		alert,
		item: findDeliverabilityItem(props.groups, alert),
	})),
);

function isBusy(alert: DeliverabilityRegressionAlert, kind: DeliverabilityAlertOperation["kind"]) {
	return props.activeOperation?.alertId === alert.id && props.activeOperation.kind === kind;
}
</script>

<template>
	<section
		v-if="rows.length"
		class="overflow-hidden rounded-xl border border-error/35 bg-error/5"
		aria-labelledby="deliverability-alerts-heading"
		aria-live="polite"
	>
		<header class="flex items-start gap-3 border-b border-error/20 px-5 py-4 sm:px-6">
			<UiIconBox icon="lucide:siren" size="sm" variant="error" rounded="lg" />
			<div>
				<h2 id="deliverability-alerts-heading" class="font-semibold text-text-primary">
					Deliverability regression{{ rows.length === 1 ? "" : "s" }} detected
				</h2>
				<p class="mt-0.5 text-sm text-text-secondary">
					A check that previously passed is failing again. Review it before your next send.
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
						{{ item?.title ?? alert.itemId }}
					</h3>
					<p class="mt-1 text-sm leading-6 text-text-secondary">{{ alert.message }}</p>
				</div>

				<dl class="flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-tertiary">
					<div v-if="alert.domain" class="flex gap-1">
						<dt>Domain:</dt>
						<dd class="font-medium text-text-secondary">{{ alert.domain }}</dd>
					</div>
					<div class="flex gap-1">
						<dt>Detected:</dt>
						<dd>
							<time :datetime="new Date(alert.observedAt).toISOString()">
								{{ formatDateTime(alert.observedAt) }}
							</time>
						</dd>
					</div>
					<div v-if="alert.acknowledgedAt" class="flex gap-1">
						<dt>Status:</dt>
						<dd>Acknowledged</dd>
					</div>
				</dl>

				<div class="flex flex-wrap items-center gap-2">
					<UiButton size="sm" variant="secondary" @click="emit('view', alert)">
						<template #iconLeft>
							<Icon name="lucide:arrow-down-to-line" class="h-3.5 w-3.5" />
						</template>
						Open check
					</UiButton>
					<UiButton
						v-if="!alert.acknowledgedAt"
						size="sm"
						variant="ghost"
						:loading="isBusy(alert, 'acknowledge')"
						:disabled="!!activeOperation"
						@click="emit('acknowledge', alert)"
					>
						Acknowledge
					</UiButton>
					<UiButton
						size="sm"
						variant="ghost"
						:loading="isBusy(alert, 'resolve')"
						:disabled="!!activeOperation"
						@click="emit('resolve', alert)"
					>
						Resolve alert
					</UiButton>
				</div>
			</article>
		</div>
	</section>
</template>
