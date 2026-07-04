<script setup lang="ts">
import { api } from '@owlat/api';

interface ChannelHealth {
	healthStatus?: 'healthy' | 'degraded' | 'down';
	lastHealthCheckAt?: number;
	lastSuccessfulSend?: number;
	lastError?: string;
}

interface ChannelConfig {
	_id: string;
	channel: 'email' | 'sms' | 'whatsapp' | 'generic' | 'chat';
	isEnabled: boolean;
	displayName?: string;
	config?: string;
	healthStatus?: 'healthy' | 'degraded' | 'down';
	lastHealthCheckAt?: number;
	lastSuccessfulSend?: number;
	lastError?: string;
	createdAt: number;
	updatedAt: number;
}

const props = defineProps<{
	channelConfig: ChannelConfig;
}>();

const emit = defineEmits<{
	saved: [];
	error: [message: string];
}>();

const { run: updateChannelConfig } = useBackendOperation(api.unifiedMessages.updateChannelConfig, {
	label: 'Toggle channel',
});

// Expand/collapse state
const isExpanded = ref(false);
const isConfiguring = ref(false);
const isTogglingEnabled = ref(false);

// Channel metadata
const channelMeta: Record<string, { icon: string; label: string; description: string }> = {
	email: {
		icon: 'lucide:mail',
		label: 'Email',
		description: 'Send and receive emails via the built-in MTA.',
	},
	sms: {
		icon: 'lucide:smartphone',
		label: 'SMS',
		description: 'Send text messages via Twilio or compatible providers.',
	},
	whatsapp: {
		icon: 'lucide:message-circle',
		label: 'WhatsApp',
		description: 'Send messages via the WhatsApp Business API.',
	},
	generic: {
		icon: 'lucide:webhook',
		label: 'Generic webhook',
		description: 'Receive inbound messages from any HTTP endpoint via a shared secret.',
	},
	chat: {
		icon: 'lucide:message-square',
		label: 'Chat',
		description: 'Native in-app chat powered by the built-in messaging system.',
	},
};

const meta = computed(
	() =>
		channelMeta[props.channelConfig.channel] ?? {
			icon: 'lucide:radio',
			label: props.channelConfig.channel,
			description: '',
		}
);

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
	if (!config.isEnabled) return 'Disabled';
	switch (config.healthStatus) {
		case 'degraded':
			return 'Degraded';
		case 'down':
			return 'Down';
		case 'healthy':
			return 'Healthy';
		default:
			return 'Unknown';
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
						:name="meta.icon"
						:class="['w-5 h-5', channelConfig.isEnabled ? 'text-brand' : 'text-text-tertiary']"
					/>
				</div>
				<div class="min-w-0">
					<div class="flex items-center gap-2.5">
						<h3 class="text-base font-medium text-text-primary">
							{{ channelConfig.displayName || meta.label }}
						</h3>
						<UiBadge :variant="getHealthBadgeVariant(channelConfig)" dot>
							{{ getHealthLabel(channelConfig) }}
						</UiBadge>
					</div>
					<p class="text-sm text-text-tertiary mt-0.5">{{ meta.description }}</p>
				</div>
			</div>

			<div class="flex items-center gap-3 shrink-0">
				<!-- Enable/Disable Toggle -->
				<UiSwitch
					:model-value="channelConfig.isEnabled"
					:disabled="isTogglingEnabled"
					:label="`Enable ${channelConfig.channel} channel`"
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
					<p class="text-xs text-text-tertiary">Last Checked</p>
					<p class="text-sm text-text-secondary mt-0.5">
						{{ formatCompactRelativeTime(channelConfig.lastHealthCheckAt) }}
					</p>
				</div>
				<div>
					<p class="text-xs text-text-tertiary">Last Successful Send</p>
					<p class="text-sm text-text-secondary mt-0.5">
						{{ formatCompactRelativeTime(channelConfig.lastSuccessfulSend) }}
					</p>
				</div>
				<div v-if="channelConfig.lastError" class="col-span-2">
					<p class="text-xs text-text-tertiary">Last Error</p>
					<p class="text-sm text-error mt-0.5 truncate" :title="channelConfig.lastError">
						{{ channelConfig.lastError }}
					</p>
				</div>
			</div>
		</div>

		<!-- Expand/Collapse Button -->
		<div class="mt-4 pt-4 border-t border-border-subtle flex items-center justify-between">
			<div class="text-xs text-text-tertiary">
				Updated {{ formatCompactRelativeTime(channelConfig.updatedAt) }}
			</div>
			<button
				class="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
				@click="isConfiguring = !isConfiguring"
			>
				<Icon name="lucide:settings" class="w-4 h-4" />
				{{ isConfiguring ? 'Close' : 'Configure' }}
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
					:current-config="channelConfig.config ?? null"
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
