<script setup lang="ts">
/**
 * One message type's routing card: what it is, the route configured for it (or
 * the "using the default" line when there is none), and the two things an
 * operator can do to it.
 *
 * Extracted from `pages/dashboard/admin/delivery/provider-routing.vue`, which
 * crossed the 500-LOC split guideline. It renders the row and nothing else —
 * the page keeps the editor modal, the mutations and the unsaved-changes guard,
 * so the card is props in, events out.
 */
import type { ProviderRouteMessageType } from '~/utils/providerRouteOptions';

interface RouteProvider {
	providerType: string;
	weight?: number;
	isEnabled: boolean;
}

interface RouteSummary {
	strategy: string;
	providers: RouteProvider[];
	ipPool?: string;
	deliverabilityFallback?: {
		isEnabled: boolean;
		relayProviderType: string;
		isWarmupOverflowEnabled: boolean;
	};
}

/** Labels in the definition set are message KEYS, per the registry convention. */
type LocalizedText = string | { key: string; params?: Record<string, unknown> };

const props = defineProps<{
	messageType: {
		value: ProviderRouteMessageType;
		icon: string;
		label: LocalizedText;
		description: LocalizedText;
	};
	/** The configured route, or `undefined` while this type uses the default. */
	route?: RouteSummary;
	strategyLabel: (strategy: string) => string;
	providerLabel: (providerType: string) => string;
}>();

const emit = defineEmits<{ edit: []; reset: [] }>();

const { t } = useI18n();

const localized = (value: LocalizedText): string =>
	typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});

const label = computed(() => localized(props.messageType.label));
const description = computed(() => localized(props.messageType.description));
</script>

<template>
	<div class="card p-6">
		<div class="flex items-start justify-between gap-4">
			<div class="flex items-start gap-4">
				<div class="p-3 rounded-lg bg-bg-surface flex items-center justify-center">
					<Icon :name="messageType.icon" class="w-6 h-6 text-text-secondary" />
				</div>
				<div>
					<h3 class="text-lg font-medium text-text-primary">{{ label }}</h3>
					<p class="text-sm text-text-secondary mt-0.5">{{ description }}</p>

					<!-- Configured route summary -->
					<DeliveryProviderRouteSummary
						v-if="route"
						:route="route"
						:strategy-label="strategyLabel"
						:provider-label="providerLabel"
					/>

					<!-- Default fallback summary -->
					<p v-else class="mt-3 text-xs text-text-tertiary inline-flex items-center gap-1.5">
						<Icon name="lucide:server" class="w-3.5 h-3.5" />
						{{ t('dashboard.admin.delivery.providerRouting.usingDefault') }}
					</p>
				</div>
			</div>

			<div class="flex items-center gap-2 shrink-0">
				<UiButton
					v-if="route"
					variant="ghost"
					class="p-2 text-error hover:bg-error/10"
					:title="t('dashboard.admin.delivery.providerRouting.resetToDefault')"
					@click="emit('reset')"
				>
					<Icon name="lucide:rotate-ccw" class="w-4 h-4" />
				</UiButton>
				<UiButton variant="secondary" class="gap-2" @click="emit('edit')">
					<Icon name="lucide:settings-2" class="w-4 h-4" />
					{{
						route ? t('common.edit') : t('dashboard.admin.delivery.providerRouting.configure')
					}}
				</UiButton>
			</div>
		</div>
	</div>
</template>
