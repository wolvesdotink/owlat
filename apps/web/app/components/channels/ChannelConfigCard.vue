<script setup lang="ts">
import { api } from '@owlat/api';
// Derived from the backend contract (see utils/channelKinds.ts) rather than
// restating the channel literals — or the health-status literals — a third
// time: widening either union there must reach this card, not stop at it.
import type { ChannelKind, ChannelHealthStatus } from '~/utils/channelKinds';

interface ChannelConfig {
	_id: string;
	channel: ChannelKind;
	isEnabled: boolean;
	displayName?: string;
	/**
	 * Credential field names already stored — never the values. The encrypted
	 * envelope itself stays in the backend (`getChannelConfigs` strips it); this
	 * is all the config form needs to mark a credential as stored.
	 */
	configuredFields?: string[];
	healthStatus?: ChannelHealthStatus;
	lastHealthCheckAt?: number;
	lastSuccessfulSend?: number;
	lastError?: string;
	createdAt: number;
	updatedAt: number;
}

const { t } = useI18n();

const props = defineProps<{
	channelConfig: ChannelConfig;
}>();

const emit = defineEmits<{
	saved: [];
	error: [message: string];
}>();

const { run: updateChannelConfig } = useBackendOperation(api.unifiedMessages.updateChannelConfig, {
	label: () => t('components.channels.channelConfigCard.operations.toggleChannel'),
});

// Expand/collapse state
const isExpanded = ref(false);
const isConfiguring = ref(false);
const isTogglingEnabled = ref(false);

// Channel metadata. `label`/`description` hold MESSAGE KEYS, not copy — the
// record is built once, so translating here would freeze the mount locale.
const channelMeta: Record<string, { icon: string; label: string; description: string }> = {
	email: {
		icon: 'lucide:mail',
		label: 'components.channels.channelConfigCard.channels.email.label',
		description: 'components.channels.channelConfigCard.channels.email.description',
	},
	sms: {
		icon: 'lucide:smartphone',
		label: 'components.channels.channelConfigCard.channels.sms.label',
		description: 'components.channels.channelConfigCard.channels.sms.description',
	},
	whatsapp: {
		icon: 'lucide:message-circle',
		label: 'components.channels.channelConfigCard.channels.whatsapp.label',
		description: 'components.channels.channelConfigCard.channels.whatsapp.description',
	},
	generic: {
		icon: 'lucide:webhook',
		label: 'components.channels.channelConfigCard.channels.generic.label',
		description: 'components.channels.channelConfigCard.channels.generic.description',
	},
	chat: {
		icon: 'lucide:message-square',
		label: 'components.channels.channelConfigCard.channels.chat.label',
		description: 'components.channels.channelConfigCard.channels.chat.description',
	},
};

const meta = computed(() => channelMeta[props.channelConfig.channel] ?? null);
// An unknown channel keeps falling back to its raw backend name and no blurb.
const metaIcon = computed(() => meta.value?.icon ?? 'lucide:radio');
const metaLabel = computed(() =>
	meta.value ? t(meta.value.label) : props.channelConfig.channel
);
const metaDescription = computed(() => (meta.value ? t(meta.value.description) : ''));

// Health status helpers
function getHealthDotClass(config: ChannelConfig): string {
	if (!config.isEnabled) return 'bg-text-tertiary';
	switch (config.healthStatus) {
		case 'degraded':
			return 'bg-warning';
		case 'down':
			return 'bg-error';
		case 'healthy':
		default:
			return 'bg-success';
	}
}

function getHealthLabel(config: ChannelConfig): string {
	if (!config.isEnabled) return t('common.disabled');
	switch (config.healthStatus) {
		case 'degraded':
			return t('components.channels.channelConfigCard.health.degraded');
		case 'down':
			return t('components.channels.channelConfigCard.health.down');
		case 'healthy':
			return t('components.channels.channelConfigCard.health.healthy');
		default:
			return t('common.unknown');
	}
}

function getHealthBadgeVariant(config: ChannelConfig): 'success' | 'warning' | 'error' | 'neutral' {
	if (!config.isEnabled) return 'neutral';
	switch (config.healthStatus) {
		case 'degraded':
			return 'warning';
		case 'down':
			return 'error';
		case 'healthy':
		default:
			return 'success';
	}
}

// Toggle enabled/disabled
async function toggleEnabled() {
	isTogglingEnabled.value = true;
	// On failure the operation module toasts the categorized message itself.
	const result = await updateChannelConfig({
		channel: props.channelConfig.channel,
		isEnabled: !props.channelConfig.isEnabled,
	});
	isTogglingEnabled.value = false;
	if (result === undefined) return;
	emit('saved');
}

function handleConfigSaved() {
	isConfiguring.value = false;
	emit('saved');
}

function handleConfigCancelled() {
	isConfiguring.value = false;
}
</script>

<template>
	<UiCard class="overflow-hidden">
		<!-- Header Row -->
		<div class="flex items-center justify-between">
			<div class="flex items-center gap-3 min-w-0">
				<div
					:class="[
						'p-2 rounded-lg shrink-0',
						channelConfig.isEnabled ? 'bg-brand-subtle' : 'bg-bg-surface',
					]"
				>
					<Icon
						:name="metaIcon"
						:class="['w-5 h-5', channelConfig.isEnabled ? 'text-brand' : 'text-text-tertiary']"
					/>
				</div>
				<div class="min-w-0">
					<div class="flex items-center gap-2.5">
						<h3 class="text-base font-medium text-text-primary">
							{{ channelConfig.displayName || metaLabel }}
						</h3>
						<UiBadge :variant="getHealthBadgeVariant(channelConfig)" dot>
							{{ getHealthLabel(channelConfig) }}
						</UiBadge>
					</div>
					<p class="text-sm text-text-tertiary mt-0.5">{{ metaDescription }}</p>
				</div>
			</div>

			<div class="flex items-center gap-3 shrink-0">
				<!-- Enable/Disable Toggle -->
				<UiSwitch
					:model-value="channelConfig.isEnabled"
					:disabled="isTogglingEnabled"
					:label="
						t('components.channels.channelConfigCard.toggleLabel', {
							channel: channelConfig.channel,
						})
					"
					@update:model-value="toggleEnabled"
				/>
			</div>
		</div>

		<!-- Health Details (always visible when channel has health data) -->
		<div
			v-if="channelConfig.isEnabled && (channelConfig.lastHealthCheckAt || channelConfig.lastError)"
			class="mt-4 pt-4 border-t border-border-subtle"
		>
			<div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
				<div>
					<p class="text-xs text-text-tertiary">
						{{ t('components.channels.channelConfigCard.lastChecked') }}
					</p>
					<p class="text-sm text-text-secondary mt-0.5">
						{{ formatCompactRelativeTime(channelConfig.lastHealthCheckAt) }}
					</p>
				</div>
				<div>
					<p class="text-xs text-text-tertiary">
						{{ t('components.channels.channelConfigCard.lastSuccessfulSend') }}
					</p>
					<p class="text-sm text-text-secondary mt-0.5">
						{{ formatCompactRelativeTime(channelConfig.lastSuccessfulSend) }}
					</p>
				</div>
				<div v-if="channelConfig.lastError" class="col-span-2">
					<p class="text-xs text-text-tertiary">
						{{ t('components.channels.channelConfigCard.lastError') }}
					</p>
					<p class="text-sm text-error mt-0.5 truncate" :title="channelConfig.lastError">
						{{ channelConfig.lastError }}
					</p>
				</div>
			</div>
		</div>

		<!-- Expand/Collapse Button -->
		<div class="mt-4 pt-4 border-t border-border-subtle flex items-center justify-between">
			<div class="text-xs text-text-tertiary">
				{{
					t('components.channels.channelConfigCard.updated', {
						time: formatCompactRelativeTime(channelConfig.updatedAt),
					})
				}}
			</div>
			<button
				class="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
				@click="isConfiguring = !isConfiguring"
			>
				<Icon name="lucide:settings" class="w-4 h-4" />
				{{ isConfiguring ? t('common.close') : t('components.channels.channelConfigCard.configure') }}
				<Icon
					name="lucide:chevron-down"
					:class="['w-4 h-4 transition-transform', isConfiguring ? 'rotate-180' : '']"
				/>
			</button>
		</div>

		<!-- Inline Config Form -->
		<Transition name="expand">
			<div v-if="isConfiguring" class="mt-4 pt-4 border-t border-border-subtle">
				<ChannelsChannelConfigForm
					:channel="channelConfig.channel"
					:stored-fields="channelConfig.configuredFields ?? []"
					:display-name="channelConfig.displayName ?? ''"
					@saved="handleConfigSaved"
					@cancelled="handleConfigCancelled"
				/>
			</div>
		</Transition>
	</UiCard>
</template>

<style scoped>
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
	max-height: 500px;
}
</style>
