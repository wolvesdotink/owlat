<script setup lang="ts">
/**
 * Notification preferences: OS permission, scope, badge counting, quiet hours
 * and preview hiding. Self-contained — reads/writes the same per-user
 * mail-settings row via usePostboxSettings, so the parent settings page stays
 * under the file-size cap. The permission strip and the quiet-hours editor are
 * split out for the same reason.
 *
 * `surface="web"` is the browser's copy, under the Web Push card: the scope
 * and quiet hours govern push exactly as they govern desktop toasts, while the
 * OS permission strip and the dock badge are desktop things, and preview
 * hiding is the push card's own "Private notifications" switch.
 */
import type { PostboxNotifyAbout } from '~/utils/postboxNotify';
import { POSTBOX_NOTIFY_ABOUT_OPTIONS, defaultPostboxNotifyAbout } from '~/utils/postboxNotify';
import { POSTBOX_PREFERENCE_DEFAULTS as DEFAULTS } from '~/utils/postboxPreferenceDefaults';
import SettingsResetToDefault from '~/components/settings/ResetToDefault.vue';

const props = withDefaults(defineProps<{ surface?: 'desktop' | 'web' }>(), {
	surface: 'desktop',
});
const isDesktopSurface = computed(() => props.surface === 'desktop');
// The web copy talks about push, not desktop notifications.
const headingKey = computed(() =>
	isDesktopSurface.value
		? 'components.postbox.postboxNotificationSettings.heading'
		: 'components.preferences.webPush.rules.heading'
);
const notifyAboutHintKey = computed(() =>
	isDesktopSurface.value
		? 'components.postbox.postboxNotificationSettings.notifyAbout.hint'
		: 'components.preferences.webPush.rules.notifyAboutHint'
);

const { t } = useI18n();

// The scope options are a frozen module-level list; their labels are message
// KEYS resolved at render time, so switching locale relabels the select.
const NOTIFY_ABOUT_LABEL_KEYS: Record<PostboxNotifyAbout, string> = {
	everything: 'components.postbox.postboxNotificationSettings.notifyAbout.everything',
	'people-important': 'components.postbox.postboxNotificationSettings.notifyAbout.peopleImportant',
	nothing: 'components.postbox.postboxNotificationSettings.notifyAbout.nothing',
};

const {
	notifyAbout,
	setNotifyAbout,
	badgeNonPeople,
	setBadgeNonPeople,
	quietHours,
	setQuietHours,
	hidePreview,
	setHidePreview,
	senderScreener,
	setSenderScreener,
	isSaving,
	isLoading,
} = usePostboxSettings();

// The scope's default follows smart categories (the `ai` flag), the same rule
// `usePostboxSettings` resolves an unset row with.
const { isEnabled } = useFeatureFlag();
const notifyAboutDefault = computed(() => defaultPostboxNotifyAbout(isEnabled('ai')));

// The "changed from default" markers stay hidden while the settings row
// loads: every value then reads as a fallback nobody chose.
const changed = computed(() => {
	if (isLoading.value) {
		return { notifyAbout: false, badgeNonPeople: false, hidePreview: false, senderScreener: false };
	}
	return {
		notifyAbout: notifyAbout.value !== notifyAboutDefault.value,
		badgeNonPeople: badgeNonPeople.value !== DEFAULTS.badgeNonPeople,
		hidePreview: hidePreview.value !== DEFAULTS.hidePreview,
		senderScreener: senderScreener.value !== DEFAULTS.senderScreener,
	};
});

function onNotifyAboutChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxNotifyAbout;
	void setNotifyAbout(value);
}
</script>

<template>
	<section class="card !p-0 mb-6">
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 class="font-semibold">
				{{ t(headingKey) }}
			</h2>
		</header>
		<PostboxNotificationPermission v-if="isDesktopSurface" />
		<!-- Stacks on a phone: the browser copy of this card is reachable there. -->
		<div
			class="px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4"
		>
			<div class="min-w-0">
				<div class="flex items-center gap-2">
					<label for="postbox-notify-about" class="font-medium text-sm block">
						{{ t('components.postbox.postboxNotificationSettings.notifyAbout.label') }}
					</label>
					<SettingsResetToDefault
						:changed="changed.notifyAbout"
						:label="t('components.postbox.postboxNotificationSettings.notifyAbout.label')"
						:disabled="isSaving"
						@reset="setNotifyAbout(notifyAboutDefault)"
					/>
				</div>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t(notifyAboutHintKey) }}
				</p>
			</div>
			<select
				id="postbox-notify-about"
				class="input w-full sm:w-64 shrink-0"
				:value="notifyAbout"
				:disabled="isSaving"
				@change="onNotifyAboutChange"
			>
				<option v-for="opt in POSTBOX_NOTIFY_ABOUT_OPTIONS" :key="opt" :value="opt">
					{{ t(NOTIFY_ABOUT_LABEL_KEYS[opt]) }}
				</option>
			</select>
		</div>
		<div
			v-if="isDesktopSurface"
			class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
		>
			<div class="min-w-0">
				<div class="flex items-center gap-2">
					<label for="postbox-badge-nonpeople" class="font-medium text-sm block">
						{{ t('components.postbox.postboxNotificationSettings.badgeAll.label') }}
					</label>
					<SettingsResetToDefault
						:changed="changed.badgeNonPeople"
						:label="t('components.postbox.postboxNotificationSettings.badgeAll.label')"
						:disabled="isSaving"
						@reset="setBadgeNonPeople(DEFAULTS.badgeNonPeople)"
					/>
				</div>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.postbox.postboxNotificationSettings.badgeAll.hint') }}
				</p>
			</div>
			<UiSwitch
				id="postbox-badge-nonpeople"
				:model-value="badgeNonPeople"
				:disabled="isSaving"
				@update:model-value="setBadgeNonPeople"
			/>
		</div>
		<PostboxQuietHoursFields
			:value="quietHours"
			:disabled="isSaving"
			:loading="isLoading"
			@update="setQuietHours($event)"
		/>
		<div
			v-if="isDesktopSurface"
			class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
		>
			<div class="min-w-0">
				<div class="flex items-center gap-2">
					<label for="postbox-hide-preview" class="font-medium text-sm block">
						{{ t('components.postbox.postboxNotificationSettings.hidePreview.label') }}
					</label>
					<SettingsResetToDefault
						:changed="changed.hidePreview"
						:label="t('components.postbox.postboxNotificationSettings.hidePreview.label')"
						:disabled="isSaving"
						@reset="setHidePreview(DEFAULTS.hidePreview)"
					/>
				</div>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.postbox.postboxNotificationSettings.hidePreview.hint') }}
				</p>
			</div>
			<UiSwitch
				id="postbox-hide-preview"
				:model-value="hidePreview"
				:disabled="isSaving"
				@update:model-value="setHidePreview"
			/>
		</div>
		<div class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle">
			<div class="min-w-0">
				<div class="flex items-center gap-2">
					<label for="postbox-sender-screener" class="font-medium text-sm block">
						{{ t('components.postbox.postboxNotificationSettings.screener.label') }}
					</label>
					<SettingsResetToDefault
						:changed="changed.senderScreener"
						:label="t('components.postbox.postboxNotificationSettings.screener.label')"
						:disabled="isSaving"
						@reset="setSenderScreener(DEFAULTS.senderScreener)"
					/>
				</div>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.postbox.postboxNotificationSettings.screener.hint') }}
				</p>
			</div>
			<UiSwitch
				id="postbox-sender-screener"
				:model-value="senderScreener"
				:disabled="isSaving"
				@update:model-value="setSenderScreener"
			/>
		</div>
	</section>
</template>
