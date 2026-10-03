<script setup lang="ts">
/**
 * Push notifications in a browser or installed web app (Preferences → This
 * device): turn them on here, send a test, see and remove every device that
 * notifies you, and keep notifications private.
 *
 * Renders nothing in the desktop app (it has native notifications) and nothing
 * while the server has no VAPID keys — the feature does not exist there. The
 * browser permission prompt only ever comes from the "Turn on" click.
 */
import type { Id } from '@owlat/api/dataModel';
import { formatCompactRelativeTime, formatDate } from '~/utils/formatters';
import { webPushStatusKey } from '~/utils/webPush';

const { t } = useI18n();

const {
	isDesktop,
	support,
	permission,
	isProbed,
	isLoading,
	error,
	refetch,
	isBusy,
	isConfigured,
	isEnabledHere,
	isPrivate,
	devices,
	enable,
	disable,
	removeDevice,
	sendTest,
	setPrivate,
} = useWebPush();

const KEY = 'components.preferences.webPush';

// Which mail notifies and when is the same preference the desktop reads; in a
// browser it is shown here, under the switch it governs.
const { isEnabled } = useFeatureFlag();
const showRules = computed(
	() =>
		!isDesktop.value && isConfigured.value && (isEnabled('postbox') || isEnabled('mail.external'))
);

const isVisible = computed(
	() =>
		!isDesktop.value && (isConfigured.value || (isLoading.value && !error.value) || !!error.value)
);
const isFirstLoad = computed(() => !isProbed.value || (isLoading.value && !isConfigured.value));

const statusLine = computed(() =>
	t(
		webPushStatusKey({
			support: support.value,
			permission: permission.value,
			isEnabledHere: isEnabledHere.value,
		})
	)
);
const canTurnOn = computed(
	() => support.value === 'supported' && permission.value !== 'denied' && !isEnabledHere.value
);

function isPhone(label: string): boolean {
	return /iPhone|iPad|Android/.test(label);
}

function deviceMeta(device: { createdAt: number; lastSuccessAt: number | null }): string {
	const added = t(`${KEY}.devices.added`, { date: formatDate(device.createdAt, 'short') });
	if (device.lastSuccessAt === null) return added;
	return `${added} · ${t(`${KEY}.devices.lastNotified`, { when: formatCompactRelativeTime(device.lastSuccessAt) })}`;
}

const removing = ref<string | null>(null);
async function onRemove(id: Id<'pushSubscriptions'>) {
	removing.value = id;
	try {
		await removeDevice(id);
	} finally {
		removing.value = null;
	}
}
</script>

<template>
	<section
		v-if="isVisible"
		id="push"
		class="card !p-0 mb-6 scroll-mt-6 overflow-hidden"
		data-testid="web-push-settings"
	>
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 class="font-semibold">{{ t(`${KEY}.heading`) }}</h2>
			<p class="text-xs text-text-tertiary mt-0.5">{{ t(`${KEY}.intro`) }}</p>
		</header>

		<div v-if="error" class="px-5 py-4">
			<UiErrorAlert
				:message="t(`${KEY}.loadFailed`)"
				:action-label="t('common.retry')"
				action-icon="lucide:rotate-cw"
				@action="refetch()"
			/>
		</div>

		<div v-else-if="isFirstLoad" class="px-5 py-4 space-y-3" aria-busy="true">
			<UiSkeleton class="h-4 w-40" />
			<UiSkeleton class="h-3 w-64" />
		</div>

		<template v-else>
			<!-- This browser -->
			<div class="px-5 py-4 flex items-center justify-between gap-4">
				<div class="min-w-0">
					<p class="font-medium text-sm">{{ t(`${KEY}.thisDevice`) }}</p>
					<p class="text-xs text-text-tertiary mt-0.5" data-testid="web-push-status">
						{{ statusLine }}
					</p>
				</div>
				<UiButton
					v-if="canTurnOn"
					size="sm"
					:loading="isBusy"
					data-testid="web-push-enable"
					@click="enable()"
				>
					{{ t(`${KEY}.turnOn`) }}
				</UiButton>
				<UiButton
					v-else-if="isEnabledHere"
					size="sm"
					variant="secondary"
					:loading="isBusy"
					data-testid="web-push-disable"
					@click="disable()"
				>
					{{ t(`${KEY}.turnOff`) }}
				</UiButton>
			</div>

			<!-- iPhone / iPad: Web Push only reaches the installed web app. -->
			<div
				v-if="support === 'needs-home-screen'"
				class="px-5 py-3 border-t border-border-subtle bg-bg-surface flex gap-3"
				data-testid="web-push-ios-hint"
			>
				<Icon name="lucide:square-arrow-up" class="w-4 h-4 mt-0.5 shrink-0 text-text-secondary" />
				<p class="text-xs text-text-secondary">{{ t(`${KEY}.iosHint`) }}</p>
			</div>

			<div
				v-else-if="permission === 'denied'"
				class="px-5 py-3 border-t border-border-subtle bg-warning-subtle"
			>
				<p class="text-xs text-text-secondary">{{ t(`${KEY}.blockedHint`) }}</p>
			</div>

			<!-- Private notifications (the shared "hide message preview" preference) -->
			<div class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle">
				<div class="min-w-0">
					<label for="web-push-private" class="font-medium text-sm block">
						{{ t(`${KEY}.private.label`) }}
					</label>
					<p class="text-xs text-text-tertiary mt-0.5">{{ t(`${KEY}.private.hint`) }}</p>
				</div>
				<UiSwitch id="web-push-private" :model-value="isPrivate" @update:model-value="setPrivate" />
			</div>

			<!-- Every device that notifies this person -->
			<div class="px-5 py-4 border-t border-border-subtle">
				<h3 class="text-sm font-medium">{{ t(`${KEY}.devices.heading`) }}</h3>
				<p
					v-if="devices.length === 0"
					class="text-xs text-text-tertiary mt-1"
					data-testid="web-push-no-devices"
				>
					{{ t(`${KEY}.devices.empty`) }}
				</p>
				<ul v-else class="mt-2 divide-y divide-border-subtle" data-testid="web-push-devices">
					<li v-for="device in devices" :key="device.id" class="py-2.5 flex items-center gap-3">
						<Icon
							:name="isPhone(device.label) ? 'lucide:smartphone' : 'lucide:monitor'"
							class="w-4 h-4 shrink-0 text-text-secondary"
						/>
						<div class="min-w-0 flex-1">
							<p class="text-sm flex items-center gap-2">
								<span class="truncate">{{ device.label }}</span>
								<UiBadge v-if="device.isCurrent" variant="neutral">
									{{ t(`${KEY}.devices.current`) }}
								</UiBadge>
							</p>
							<p class="text-xs text-text-tertiary">{{ deviceMeta(device) }}</p>
						</div>
						<UiButton size="sm" variant="ghost" @click="sendTest(device.id)">
							{{ t(`${KEY}.devices.test`) }}
						</UiButton>
						<UiButton
							size="sm"
							variant="ghost"
							:loading="removing === device.id"
							:aria-label="t(`${KEY}.devices.removeLabel`, { device: device.label })"
							@click="onRemove(device.id)"
						>
							{{ t(`${KEY}.devices.remove`) }}
						</UiButton>
					</li>
				</ul>
			</div>
		</template>
	</section>
	<div v-if="showRules" id="notifications" class="scroll-mt-6">
		<PostboxNotificationSettings surface="web" />
	</div>
</template>
