<script setup lang="ts">
import { api } from '@owlat/api';
import { ADDABLE_CHANNEL_KINDS, availableChannelKinds as computeAvailableChannelKinds, type ChannelKind } from '~/utils/channelKinds';

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

useHead({ title: 'Communication Channels — Owlat' });

const { data: channels, isLoading } = useOrganizationQuery(api.unifiedMessages.getChannelConfigs);

// Adding a channel requires `organization:manage` (owner/admin). The backend
// re-checks via `requireOrgPermission`; the client-side gate is here so editors
// don't see an affordance that 403s on click.
const { role } = useOrganizationContext();
const canManageChannels = computed(() => role.value === 'owner' || role.value === 'admin');

// Only the external messaging channels that take provider credentials are
// addable here — `ADDABLE_CHANNEL_KINDS` deliberately excludes the built-in
// `email` and `chat` kinds (email sending is configured under Sending Domains +
// the delivery provider; chat is native). Filter out kinds that already have a
// config row — `updateChannelConfig` is an upsert keyed on channel, so re-adding
// an existing kind is a silent no-op.
const availableChannelKinds = computed(() =>
	computeAvailableChannelKinds(channels.value ?? [], ADDABLE_CHANNEL_KINDS)
);

const addMenuOpen = ref(false);
const addingChannel = ref(false);

const { run: addChannelConfig } = useBackendOperation(api.unifiedMessages.updateChannelConfig, {
	label: 'Add channel',
});

async function addChannel(kind: ChannelKind) {
	if (addingChannel.value) return;
	addingChannel.value = true;
	// Insert a disabled row via the upsert path; the new card appears reactively
	// via the getChannelConfigs subscription, where credentials are configured.
	const result = await addChannelConfig({ channel: kind, isEnabled: false });
	addingChannel.value = false;
	if (result === undefined) return;
	displayToast('Channel added — configure it below');
}

// Computed stats for sidebar
const totalChannels = computed(() => channels.value?.length ?? 0);
const enabledChannels = computed(() => channels.value?.filter((c) => c.isEnabled).length ?? 0);

const healthyCounts = computed(() => {
	if (!channels.value) return { healthy: 0, degraded: 0, down: 0 };
	const list = channels.value;
	return {
		healthy: list.filter((c) => c.isEnabled && (!c.healthStatus || c.healthStatus === 'healthy')).length,
		degraded: list.filter((c) => c.isEnabled && c.healthStatus === 'degraded').length,
		down: list.filter((c) => c.isEnabled && c.healthStatus === 'down').length,
	};
});

// Toast notifications (global)
const { showToast: displayToast } = useToast();

const handleChannelSaved = () => {
	displayToast('Channel configuration saved successfully');
};

const handleChannelError = (message: string) => {
	displayToast(message, 'error');
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Back Navigation -->
		<NuxtLink
			to="/dashboard/settings"
			class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			Back to Settings
		</NuxtLink>

		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
			<div class="flex items-center gap-4">
				<UiIconBox icon="lucide:radio" size="xl" variant="brand" rounded="full" />
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Messaging Channels</h1>
					<p class="text-text-secondary mt-1 max-w-xl">
						Connect and monitor the external messaging channels — SMS, WhatsApp, and
						generic webhooks — that reach your contacts beyond email. Once enabled, send a
						message to a contact from their Unified Timeline, and AI agent replies dispatch
						through them too. Email and team chat are built in and need no setup here; to
						configure email sending, set up your
						<NuxtLink to="/dashboard/settings/delivery" class="text-brand hover:underline">delivery provider</NuxtLink>
						and a verified
						<NuxtLink to="/dashboard/settings/domains" class="text-brand hover:underline">sending domain</NuxtLink>.
					</p>
				</div>
			</div>

			<!-- Add channel (admin-only) -->
			<UiDropdownMenu
				v-if="canManageChannels && availableChannelKinds.length"
				v-model:open="addMenuOpen"
				position="right"
				class="shrink-0"
			>
				<template #trigger>
					<UiButton variant="secondary" :loading="addingChannel">
						<template #iconLeft>
							<Icon name="lucide:plus" class="w-4 h-4" />
						</template>
						Add channel
					</UiButton>
				</template>
				<UiDropdownMenuItem
					v-for="option in availableChannelKinds"
					:key="option.kind"
					:icon="option.icon"
					@click="addChannel(option.kind)"
				>
					{{ option.label }}
				</UiDropdownMenuItem>
			</UiDropdownMenu>
		</div>

		<!-- Loading State -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading channel configurations...</p>
			</div>
		</div>

		<template v-else>
			<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
				<!-- Main content: channel list -->
				<div class="lg:col-span-2 space-y-4">
					<!-- Channel Cards -->
					<ChannelsChannelConfigCard
						v-for="channel in channels"
						:key="channel._id"
						:channel-config="channel"
						@saved="handleChannelSaved"
						@error="handleChannelError"
					/>

					<!-- Empty State -->
					<UiCard v-if="!channels?.length">
						<div class="py-8 text-center">
							<UiIconBox
								icon="lucide:radio"
								size="lg"
								variant="surface"
								class="mx-auto mb-4"
							/>
							<h3 class="text-base font-medium text-text-primary mb-2">No channels configured</h3>
							<p class="text-sm text-text-tertiary mb-4 max-w-sm mx-auto">
								<template v-if="canManageChannels">
									Use <span class="font-medium text-text-secondary">Add channel</span>
									above to configure a communication channel for your organization.
								</template>
								<template v-else>
									Communication channels will appear here once an owner or admin has
									configured them for your organization.
								</template>
							</p>
						</div>
					</UiCard>
				</div>

				<!-- Sidebar -->
				<div class="space-y-4">
					<!-- Channel Overview -->
					<UiCard>
						<div class="flex items-center gap-3 mb-4">
							<UiIconBox icon="lucide:bar-chart-3" size="sm" variant="surface" />
							<h3 class="text-base font-medium text-text-primary">Channel Overview</h3>
						</div>

						<div class="space-y-3">
							<div class="flex items-center justify-between py-2 border-b border-border-subtle">
								<span class="text-sm text-text-secondary">Total channels</span>
								<span class="text-sm font-semibold text-text-primary">{{ totalChannels }}</span>
							</div>
							<div class="flex items-center justify-between py-2 border-b border-border-subtle">
								<span class="text-sm text-text-secondary">Enabled</span>
								<span class="text-sm font-semibold text-text-primary">{{ enabledChannels }}</span>
							</div>
							<div class="flex items-center justify-between py-2 border-b border-border-subtle">
								<div class="flex items-center gap-2">
									<span class="w-2 h-2 rounded-full bg-success shrink-0" />
									<span class="text-sm text-text-secondary">Healthy</span>
								</div>
								<span class="text-sm font-semibold text-text-primary">{{ healthyCounts.healthy }}</span>
							</div>
							<div class="flex items-center justify-between py-2 border-b border-border-subtle">
								<div class="flex items-center gap-2">
									<span class="w-2 h-2 rounded-full bg-warning shrink-0" />
									<span class="text-sm text-text-secondary">Degraded</span>
								</div>
								<span class="text-sm font-semibold text-text-primary">{{ healthyCounts.degraded }}</span>
							</div>
							<div class="flex items-center justify-between py-2">
								<div class="flex items-center gap-2">
									<span class="w-2 h-2 rounded-full bg-error shrink-0" />
									<span class="text-sm text-text-secondary">Down</span>
								</div>
								<span class="text-sm font-semibold text-text-primary">{{ healthyCounts.down }}</span>
							</div>
						</div>
					</UiCard>

					<!-- How Channels Work -->
					<UiCard>
						<div class="flex items-center gap-3 mb-4">
							<UiIconBox icon="lucide:info" size="sm" variant="surface" />
							<h3 class="text-base font-medium text-text-primary">How Channels Work</h3>
						</div>
						<div class="space-y-3 text-sm text-text-secondary">
							<div class="flex gap-3">
								<span class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center">1</span>
								<p>Each channel is an external messaging medium (SMS, WhatsApp, or a generic webhook).</p>
							</div>
							<div class="flex gap-3">
								<span class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center">2</span>
								<p>Channels use adapters to connect to their providers. Configure each channel's credentials below.</p>
							</div>
							<div class="flex gap-3">
								<span class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center">3</span>
								<p>Health monitoring runs automatically and reports status for each enabled channel.</p>
							</div>
							<div class="flex gap-3">
								<span class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center">4</span>
								<p>Inbound messages flow into the unified pipeline for every channel. Once a channel is enabled, send outbound from a contact's Unified Timeline — SMS, WhatsApp, and generic dispatch through their configured providers, alongside AI agent replies.</p>
							</div>
						</div>
					</UiCard>
				</div>
			</div>
		</template>
	</div>
</template>
