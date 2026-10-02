<script setup lang="ts">
import { api } from '@owlat/api';
import {
	ADDABLE_CHANNEL_KINDS,
	availableChannelKinds as computeAvailableChannelKinds,
	type ChannelKind,
} from '~/utils/channelKinds';
import { useLocalized } from '~/composables/useLocalized';

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
});

const { t } = useI18n();

/**
 * `ADDABLE_CHANNEL_KINDS` is a module-scope registry evaluated at import time,
 * so it carries message KEYS (optionally with params) rather than sentences —
 * resolving them is the consumer's job. A plain string still reads as a key.
 */
const localized = useLocalized();

useHead({ title: () => t('dashboard.admin.instance.channels.pageTitle') });

const {
	data: channels,
	isLoading,
	error: channelsError,
	refetch: refetchChannels,
} = useOrganizationQuery(api.unifiedMessages.getChannelConfigs);

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
// UiPageHeader puts its actions on the title row from lg (1024px) up.
const isLgViewport = useMediaQuery('(min-width: 1024px)');
const addingChannel = ref(false);

const { run: addChannelConfig } = useBackendOperation(api.unifiedMessages.updateChannelConfig, {
	label: () => t('dashboard.admin.instance.channels.addChannel'),
});

async function addChannel(kind: ChannelKind) {
	if (addingChannel.value) return;
	addingChannel.value = true;
	// Insert a disabled row via the upsert path; the new card appears reactively
	// via the getChannelConfigs subscription, where credentials are configured.
	const result = await addChannelConfig({ channel: kind, isEnabled: false });
	addingChannel.value = false;
	if (!result.ok) return;
	displayToast(t('dashboard.admin.instance.channels.addedToast'));
}

// Computed stats for sidebar
const totalChannels = computed(() => channels.value?.length ?? 0);
const enabledChannels = computed(() => channels.value?.filter((c) => c.isEnabled).length ?? 0);

const healthyCounts = computed(() => {
	if (!channels.value) return { healthy: 0, degraded: 0, down: 0 };
	const list = channels.value;
	return {
		healthy: list.filter((c) => c.isEnabled && (!c.healthStatus || c.healthStatus === 'healthy'))
			.length,
		degraded: list.filter((c) => c.isEnabled && c.healthStatus === 'degraded').length,
		down: list.filter((c) => c.isEnabled && c.healthStatus === 'down').length,
	};
});

// Toast notifications (global)
const { showToast: displayToast } = useToast();

const handleChannelSaved = () => {
	displayToast(t('dashboard.admin.instance.channels.savedToast'));
};

const handleChannelError = (message: string) => {
	displayToast(message, 'error');
};
</script>

<template>
	<div>
		<UiPageHeader :title="t('dashboard.admin.instance.channels.title')" class="mb-8">
			<template #description>
				<I18nT keypath="dashboard.admin.instance.channels.subtitle" tag="p" scope="global">
					<template #transportLink>
						<NuxtLink to="/dashboard/admin/delivery/transport" class="text-brand hover:underline">{{
							t('dashboard.admin.instance.channels.subtitleTransportLink')
						}}</NuxtLink>
					</template>
					<template #domainLink>
						<NuxtLink to="/dashboard/admin/delivery/domains" class="text-brand hover:underline">{{
							t('dashboard.admin.instance.channels.subtitleDomainLink')
						}}</NuxtLink>
					</template>
				</I18nT>
			</template>

			<!-- Add channel (admin-only). Below lg the header actions wrap under
			     the title at the left edge, where a right-aligned menu would open
			     off-screen, so it aligns left there. -->
			<template v-if="canManageChannels && availableChannelKinds.length" #actions>
				<UiDropdownMenu v-model:open="addMenuOpen" :position="isLgViewport ? 'right' : 'left'">
					<template #trigger>
						<UiButton variant="secondary" :loading="addingChannel">
							<template #iconLeft>
								<Icon name="lucide:plus" class="w-4 h-4" />
							</template>
							{{ t('dashboard.admin.instance.channels.addChannel') }}
						</UiButton>
					</template>
					<UiDropdownMenuItem
						v-for="option in availableChannelKinds"
						:key="option.kind"
						:icon="option.icon"
						@click="addChannel(option.kind)"
					>
						{{ localized(option.label) }}
					</UiDropdownMenuItem>
				</UiDropdownMenu>
			</template>
		</UiPageHeader>

		<!-- First-load skeleton (shaped like the channel list) -->
		<div v-if="isLoading && !channels" class="card overflow-hidden">
			<DashboardListSkeleton variant="card" leading :rows="3" />
		</div>

		<!-- A failed read is not an empty channel list (#721). -->
		<UiQueryBoundary v-else-if="channelsError" :error="channelsError" @retry="refetchChannels" />

		<template v-else>
			<!-- The page is wide (registry): list and sidebar sit side by side once
			     the content area has room for both, and stack below that. -->
			<div class="grid grid-cols-1 xl:grid-cols-3 gap-6">
				<!-- Main content: channel list -->
				<div class="xl:col-span-2 space-y-4">
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
							<UiIconBox icon="lucide:radio" size="lg" variant="surface" class="mx-auto mb-4" />
							<h3 class="text-base font-medium text-text-primary mb-2">
								{{ t('dashboard.admin.instance.channels.emptyTitle') }}
							</h3>
							<p class="text-sm text-text-tertiary mb-4 max-w-sm mx-auto">
								<I18nT
									v-if="canManageChannels"
									keypath="dashboard.admin.instance.channels.emptyBodyAdmin"
									tag="span"
									scope="global"
								>
									<template #action>
										<span class="font-medium text-text-secondary">{{
											t('dashboard.admin.instance.channels.addChannel')
										}}</span>
									</template>
								</I18nT>
								<template v-else>
									{{ t('dashboard.admin.instance.channels.emptyBodyMember') }}
								</template>
							</p>
						</div>
					</UiCard>
				</div>

				<!-- Sidebar: two columns under the list while stacked -->
				<div class="grid gap-4 content-start items-start md:grid-cols-2 xl:grid-cols-1">
					<!-- Channel Overview -->
					<UiCard>
						<div class="flex items-center gap-3 mb-4">
							<UiIconBox icon="lucide:bar-chart-3" size="sm" variant="surface" />
							<h3 class="text-base font-medium text-text-primary">
								{{ t('dashboard.admin.instance.channels.overview.title') }}
							</h3>
						</div>

						<div class="space-y-3">
							<div class="flex items-center justify-between py-2 border-b border-border-subtle">
								<span class="text-sm text-text-secondary">{{
									t('dashboard.admin.instance.channels.overview.total')
								}}</span>
								<span class="text-sm font-semibold text-text-primary">{{ totalChannels }}</span>
							</div>
							<div class="flex items-center justify-between py-2 border-b border-border-subtle">
								<span class="text-sm text-text-secondary">{{ t('common.enabled') }}</span>
								<span class="text-sm font-semibold text-text-primary">{{ enabledChannels }}</span>
							</div>
							<div class="flex items-center justify-between py-2 border-b border-border-subtle">
								<div class="flex items-center gap-2">
									<span class="w-2 h-2 rounded-full bg-success shrink-0" />
									<span class="text-sm text-text-secondary">{{
										t('dashboard.admin.instance.channels.overview.healthy')
									}}</span>
								</div>
								<span class="text-sm font-semibold text-text-primary">{{
									healthyCounts.healthy
								}}</span>
							</div>
							<div class="flex items-center justify-between py-2 border-b border-border-subtle">
								<div class="flex items-center gap-2">
									<span class="w-2 h-2 rounded-full bg-warning shrink-0" />
									<span class="text-sm text-text-secondary">{{
										t('dashboard.admin.instance.channels.overview.degraded')
									}}</span>
								</div>
								<span class="text-sm font-semibold text-text-primary">{{
									healthyCounts.degraded
								}}</span>
							</div>
							<div class="flex items-center justify-between py-2">
								<div class="flex items-center gap-2">
									<span class="w-2 h-2 rounded-full bg-error shrink-0" />
									<span class="text-sm text-text-secondary">{{
										t('dashboard.admin.instance.channels.overview.down')
									}}</span>
								</div>
								<span class="text-sm font-semibold text-text-primary">{{
									healthyCounts.down
								}}</span>
							</div>
						</div>
					</UiCard>

					<!-- How Channels Work -->
					<UiCard>
						<div class="flex items-center gap-3 mb-4">
							<UiIconBox icon="lucide:info" size="sm" variant="surface" />
							<h3 class="text-base font-medium text-text-primary">
								{{ t('dashboard.admin.instance.channels.howItWorks.title') }}
							</h3>
						</div>
						<div class="space-y-3 text-sm text-text-secondary">
							<div class="flex gap-3">
								<span
									class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center"
									>1</span
								>
								<p>{{ t('dashboard.admin.instance.channels.howItWorks.step1') }}</p>
							</div>
							<div class="flex gap-3">
								<span
									class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center"
									>2</span
								>
								<p>{{ t('dashboard.admin.instance.channels.howItWorks.step2') }}</p>
							</div>
							<div class="flex gap-3">
								<span
									class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center"
									>3</span
								>
								<p>{{ t('dashboard.admin.instance.channels.howItWorks.step3') }}</p>
							</div>
							<div class="flex gap-3">
								<span
									class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center"
									>4</span
								>
								<p>{{ t('dashboard.admin.instance.channels.howItWorks.step4') }}</p>
							</div>
						</div>
					</UiCard>
				</div>
			</div>
		</template>
	</div>
</template>
