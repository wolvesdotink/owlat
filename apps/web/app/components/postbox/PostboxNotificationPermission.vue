<script setup lang="ts">
/**
 * OS notification permission strip for the desktop settings panel: what the
 * system currently allows, a way to ask for it, a test notification that proves
 * it, and — when the system has refused — a banner linking the settings pane
 * that is the only route back.
 *
 * Mounted only inside the desktop app (the parent section is `v-if="isDesktop"`).
 */
const { t } = useI18n();
const { showToast } = useToast();
const { permission, isBusy, isDenied, osSettingsUri, refresh, request, sendTest, openOsSettings } =
	useDesktopNotificationPermission();

const KEY = 'components.postbox.postboxNotificationSettings.permission';

// Read the live state when the panel opens: the user may have changed it in
// the OS since the app asked at startup.
onMounted(() => void refresh());

const statusLabel = computed(() => {
	if (permission.value === 'granted') return t(`${KEY}.granted`);
	if (permission.value === 'denied') return t(`${KEY}.denied`);
	return t(`${KEY}.prompt`);
});

// 'unavailable' (no bridge, or the plugin threw) is shown as the neutral
// not-yet state rather than as a failure: sending still works, we just can't
// prove the permission from here.
const statusClass = computed(() =>
	permission.value === 'granted'
		? 'border-success text-success'
		: permission.value === 'denied'
			? 'border-warning text-warning'
			: 'border-border-subtle text-text-tertiary'
);

async function onTest() {
	const sent = await sendTest(t(`${KEY}.testTitle`), t(`${KEY}.testBody`));
	showToast(sent ? t(`${KEY}.testSent`) : t(`${KEY}.testFailed`), sent ? 'success' : 'error');
}

async function onOpenSettings() {
	if (!(await openOsSettings())) showToast(t(`${KEY}.openSettingsFailed`), 'info');
}
</script>

<template>
	<div class="px-5 py-4 border-b border-border-subtle flex flex-wrap items-center gap-3">
		<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border" :class="statusClass">
			<Icon
				:name="permission === 'granted' ? 'lucide:bell' : 'lucide:bell-off'"
				class="w-3.5 h-3.5"
			/>
			{{ statusLabel }}
		</span>
		<UiButton
			v-if="permission !== 'granted' && !isDenied"
			size="sm"
			variant="secondary"
			:loading="isBusy"
			@click="request()"
		>
			{{ t(`${KEY}.allow`) }}
		</UiButton>
		<UiButton size="sm" variant="ghost" :disabled="isDenied" @click="onTest()">
			{{ t(`${KEY}.test`) }}
		</UiButton>
	</div>
	<!-- Refused permission: nothing in the app can undo it, so point at the pane
	     that can (and, on Linux, say where to look instead of guessing a URI). -->
	<div v-if="isDenied" class="px-5 py-3 border-b border-border-subtle bg-warning-subtle">
		<p class="text-xs text-text-secondary">
			{{ osSettingsUri ? t(`${KEY}.deniedHint`) : t(`${KEY}.deniedHintLinux`) }}
		</p>
		<UiButton v-if="osSettingsUri" size="sm" variant="outline" class="mt-2" @click="onOpenSettings()">
			{{ t(`${KEY}.openSettings`) }}
		</UiButton>
	</div>
</template>
