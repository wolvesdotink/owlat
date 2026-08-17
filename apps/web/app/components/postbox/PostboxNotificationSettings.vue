<script setup lang="ts">
/**
 * Desktop-only native notification preferences (scope + badge counting).
 * Self-contained: reads/writes the same per-user mail-settings row via
 * usePostboxSettings, so the parent settings page stays under the file-size cap.
 */
import type { PostboxNotifyAbout } from '~/utils/postboxNotify';
import { POSTBOX_NOTIFY_ABOUT_OPTIONS } from '~/utils/postboxNotify';

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
	senderScreener,
	setSenderScreener,
	isSaving,
} = usePostboxSettings();

function onNotifyAboutChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxNotifyAbout;
	void setNotifyAbout(value);
}

function onBadgeNonPeopleChange(event: Event) {
	void setBadgeNonPeople((event.target as HTMLInputElement).checked);
}

function onSenderScreenerChange(event: Event) {
	void setSenderScreener((event.target as HTMLInputElement).checked);
}
</script>

<template>
	<section class="card !p-0 mb-6">
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 class="font-semibold">
				{{ t('components.postbox.postboxNotificationSettings.heading') }}
			</h2>
		</header>
		<div class="px-5 py-4 flex items-center justify-between gap-4">
			<div class="min-w-0">
				<label for="postbox-notify-about" class="font-medium text-sm block">
					{{ t('components.postbox.postboxNotificationSettings.notifyAbout.label') }}
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.postbox.postboxNotificationSettings.notifyAbout.hint') }}
				</p>
			</div>
			<select
				id="postbox-notify-about"
				class="input w-64 shrink-0"
				:value="notifyAbout"
				:disabled="isSaving"
				@change="onNotifyAboutChange"
			>
				<option v-for="opt in POSTBOX_NOTIFY_ABOUT_OPTIONS" :key="opt" :value="opt">
					{{ t(NOTIFY_ABOUT_LABEL_KEYS[opt]) }}
				</option>
			</select>
		</div>
		<div class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle">
			<div class="min-w-0">
				<label for="postbox-badge-nonpeople" class="font-medium text-sm block">
					{{ t('components.postbox.postboxNotificationSettings.badgeAll.label') }}
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.postbox.postboxNotificationSettings.badgeAll.hint') }}
				</p>
			</div>
			<input
				id="postbox-badge-nonpeople"
				type="checkbox"
				class="shrink-0 h-4 w-4"
				:checked="badgeNonPeople"
				:disabled="isSaving"
				@change="onBadgeNonPeopleChange"
			/>
		</div>
		<div class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle">
			<div class="min-w-0">
				<label for="postbox-sender-screener" class="font-medium text-sm block">
					{{ t('components.postbox.postboxNotificationSettings.screener.label') }}
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.postbox.postboxNotificationSettings.screener.hint') }}
				</p>
			</div>
			<input
				id="postbox-sender-screener"
				type="checkbox"
				class="shrink-0 h-4 w-4"
				:checked="senderScreener"
				:disabled="isSaving"
				@change="onSenderScreenerChange"
			/>
		</div>
	</section>
</template>
