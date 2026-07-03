<script setup lang="ts">
/**
 * Desktop-only native notification preferences (scope + badge counting).
 * Self-contained: reads/writes the same per-user mail-settings row via
 * usePostboxSettings, so the parent settings page stays under the file-size cap.
 */
import type { PostboxNotifyAbout } from '~/utils/postboxNotify';
import { POSTBOX_NOTIFY_ABOUT_OPTIONS } from '~/utils/postboxNotify';

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
			<h2 class="font-semibold">Notifications</h2>
		</header>
		<div class="px-5 py-4 flex items-center justify-between gap-4">
			<div class="min-w-0">
				<label for="postbox-notify-about" class="font-medium text-sm block">
					Notify me about
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					Which new mail pops a desktop notification. "People &amp; important
					only" uses smart categories to stay quiet about newsletters and
					automated mail.
				</p>
			</div>
			<select
				id="postbox-notify-about"
				class="input w-64 shrink-0"
				:value="notifyAbout"
				:disabled="isSaving"
				@change="onNotifyAboutChange"
			>
				<option
					v-for="opt in POSTBOX_NOTIFY_ABOUT_OPTIONS"
					:key="opt.value"
					:value="opt.value"
				>
					{{ opt.label }}
				</option>
			</select>
		</div>
		<div
			class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
		>
			<div class="min-w-0">
				<label for="postbox-badge-nonpeople" class="font-medium text-sm block">
					Count all mail in the badge
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					When off, the dock/tray unread badge counts only people &amp;
					important mail — keeping the number focused even when notifications
					are quiet. On by default.
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
		<div
			class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
		>
			<div class="min-w-0">
				<label for="postbox-sender-screener" class="font-medium text-sm block">
					Screen first-time senders
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					When on, mail from someone you've never corresponded with is held out
					of the Reply Queue until you accept the sender — their mail still
					lands in the inbox. Keeps triage focused on people you know. Off by
					default.
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
