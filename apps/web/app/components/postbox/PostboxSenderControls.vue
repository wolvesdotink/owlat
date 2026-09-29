<script setup lang="ts">
import { extractEmailAddress } from '~/utils/emailAddress';

/**
 * Per-sender triage corrections in the thread reader header: an explicit VIP
 * ("important sender") star and a HEY-style "Accept sender" button for a
 * first-time sender the screener is holding out of the Reply Queue.
 *
 * These are the transparent, easy-to-correct overrides of the deterministic
 * frecency baseline — a VIP dominates the priority score, and accepting a
 * screened sender lets their mail into the queue from now on. State and both
 * actions come from `usePostboxSenderState`, shared with the sender profile.
 * Fail-soft: the query returns a safe empty state for anonymous / no-access
 * reads, so nothing renders and the reader is never blocked.
 */
const props = defineProps<{
	mailboxId: string;
	fromAddress: string;
}>();

const { t } = useI18n();

const { isVip, canAccept, toggleVip, acceptSender, busy } = usePostboxSenderState({
	mailboxId: () => props.mailboxId,
	email: () => extractEmailAddress(props.fromAddress),
});
</script>

<template>
	<div class="flex items-center gap-1.5 flex-shrink-0">
		<button
			v-if="canAccept"
			type="button"
			class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium bg-brand/10 text-brand hover:bg-brand/20 disabled:opacity-50"
			:title="t('components.postbox.postboxSenderControls.acceptTitle')"
			:aria-label="t('components.postbox.postboxSenderControls.accept')"
			:disabled="busy"
			@click.stop.prevent="acceptSender"
		>
			<Icon name="lucide:user-check" class="w-3.5 h-3.5" />
			{{ t('components.postbox.postboxSenderControls.accept') }}
		</button>
		<button
			type="button"
			class="text-text-tertiary hover:text-warning disabled:opacity-50"
			:class="{ 'text-warning': isVip }"
			:title="
				isVip
					? t('components.postbox.postboxSenderControls.removeVip')
					: t('components.postbox.postboxSenderControls.markVip')
			"
			:aria-label="
				isVip
					? t('components.postbox.postboxSenderControls.removeVip')
					: t('components.postbox.postboxSenderControls.markVip')
			"
			:aria-pressed="isVip"
			:disabled="busy"
			@click.stop.prevent="toggleVip"
		>
			<Icon name="lucide:crown" class="w-3.5 h-3.5" :class="{ 'fill-current': isVip }" />
		</button>
	</div>
</template>
