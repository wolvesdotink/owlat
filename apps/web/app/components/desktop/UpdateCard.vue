<script setup lang="ts">
/**
 * The Updates card on "This device" — version, who decides which update this
 * app gets, the auto-check toggle, and whatever the current update run is
 * doing.
 *
 * It owns no update logic: `lib/desktop/updater.client.ts` runs the check from
 * the boot plugin and from the `owlat:check-updates` window event, and writes
 * its progress into `useDesktopUpdateState`. This reads that store, so a card
 * mounted halfway through a download shows the download rather than starting a
 * second one. "Check for updates now" dispatches the same event the native menu
 * and the palette dispatch.
 *
 * Lives here rather than inline on device.vue because that page is already near
 * the file-size ratchet and this is the one section with moving parts.
 */
import { restartToUpdate } from '~/lib/desktop/updater.client';

const { t, locale } = useI18n();
const { settings, isReady, setGlobal } = useDesktopAppSettings();
const { phase, version, percent, downloadedBytes, totalBytes, lastCheckedAt, source } =
	useDesktopUpdateState();

const appVersion = ref('');
onMounted(async () => {
	try {
		const { getVersion } = await import('@tauri-apps/api/app');
		appVersion.value = await getVersion();
	} catch {
		// Not running under Tauri.
	}
});

/** Who chose this update: the connected instance, or GitHub as ever. */
const managedBy = computed(() => {
	const current = source.value;
	if (!current) return '';
	if (current.kind === 'github') return t('desktop.settings.updates.viaGithub');
	const { mode, channel, pinnedVersion } = current.policy;
	const policy =
		mode === 'paused'
			? t('desktop.settings.updates.policy.paused')
			: mode === 'pinned'
				? t('desktop.settings.updates.policy.pinned', { version: pinnedVersion ?? '' })
				: t('desktop.settings.updates.policy.latest', {
						channel: t(`desktop.settings.updates.channel.${channel}`),
					});
	return t('desktop.settings.updates.managedBy', { host: current.host, policy });
});

const sizeFormatter = computed(() => new Intl.NumberFormat(locale.value, {
	maximumFractionDigits: 1,
}));

function megabytes(bytes: number): string {
	return `${sizeFormatter.value.format(bytes / 1024 / 1024)} MB`;
}

/** "18.4 MB of 29.6 MB", or just what has arrived when the size is unknown. */
const downloadLabel = computed(() => {
	const done = megabytes(downloadedBytes.value);
	return totalBytes.value === null ? done : `${done} / ${megabytes(totalBytes.value)}`;
});

const lastChecked = computed(() => {
	const at = lastCheckedAt.value;
	if (at === null) return '';
	return t('desktop.settings.updates.lastChecked', {
		time: new Date(at).toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit' }),
	});
});

function checked(event: Event): boolean {
	return (event.target as HTMLInputElement).checked;
}

function checkForUpdatesNow() {
	window.dispatchEvent(new Event('owlat:check-updates'));
}

const isRestarting = ref(false);
async function restart() {
	isRestarting.value = true;
	try {
		await restartToUpdate();
	} finally {
		// Only reached when the relaunch itself failed — a successful restart
		// never returns to this component.
		isRestarting.value = false;
	}
}
</script>

<template>
	<div>
		<div class="flex items-center justify-between gap-4">
			<span>
				<span class="block text-sm font-medium">{{ t('desktop.settings.updates.title') }}</span>
				<span class="block text-xs text-text-tertiary">
					{{ appVersion ? t('desktop.settings.updates.version', { version: appVersion }) : '' }}
					{{ managedBy || t('desktop.settings.updates.description') }}
				</span>
			</span>
			<input
				type="checkbox"
				class="h-5 w-5 shrink-0 accent-brand"
				:aria-label="t('desktop.settings.updates.description')"
				:checked="settings.global.autoCheckUpdates"
				:disabled="!isReady"
				@change="setGlobal('autoCheckUpdates', checked($event))"
			/>
		</div>

		<!-- Downloading: the bytes arrive in the background; only the restart is asked for. -->
		<div v-if="phase === 'downloading'" class="mt-3 space-y-1">
			<div
				class="h-2 rounded-full bg-bg-base overflow-hidden"
				role="progressbar"
				:aria-valuenow="percent ?? undefined"
				aria-valuemin="0"
				aria-valuemax="100"
				:aria-label="t('desktop.settings.updates.downloading', { version: version ?? '' })"
			>
				<div
					class="h-full bg-brand transition-[width] duration-300 motion-reduce:transition-none"
					:class="percent === null ? 'animate-pulse motion-reduce:animate-none' : ''"
					:style="{ width: percent === null ? '100%' : `${percent}%` }"
				/>
			</div>
			<p class="text-xs text-text-tertiary" aria-live="polite">
				{{ t('desktop.settings.updates.downloading', { version: version ?? '' }) }}
				<span class="tabular-nums">{{ downloadLabel }}</span>
			</p>
		</div>

		<!-- Ready: the update is on disk and applies on the next launch. -->
		<div v-else-if="phase === 'ready'" class="mt-3 flex items-center gap-3">
			<p class="text-xs text-text-secondary">
				{{ t('desktop.settings.updates.ready', { version: version ?? '' }) }}
			</p>
			<UiButton size="sm" :disabled="isRestarting" @click="restart">
				{{ t('desktop.settings.updates.restartNow') }}
			</UiButton>
		</div>

		<template v-else>
			<UiButton
				variant="outline"
				size="sm"
				class="mt-3"
				:disabled="phase === 'checking'"
				@click="checkForUpdatesNow"
			>
				{{ t('desktop.settings.updates.checkNow') }}
			</UiButton>
			<p v-if="phase === 'checking'" class="mt-2 text-xs text-text-tertiary">
				{{ t('desktop.settings.updates.checking') }}
			</p>
			<p v-else-if="phase === 'error'" class="mt-2 text-xs text-error">
				{{ t('desktop.settings.updates.failed') }}
			</p>
			<p v-else-if="lastChecked" class="mt-2 text-xs text-text-tertiary">{{ lastChecked }}</p>
		</template>
	</div>
</template>
