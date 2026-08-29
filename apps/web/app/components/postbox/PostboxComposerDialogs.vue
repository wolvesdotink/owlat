<script setup lang="ts">
/**
 * Every dialog that PARKS a send until the sender answers.
 *
 * Split out of `PostboxComposer.vue` for the ~500 LOC ratchet, but they belong
 * together on their own terms: all three sit on the same `blockSend(opts)` +
 * `onConfirm` replay contract, so confirming does not start a NEW send — it
 * resumes the exact one that was interrupted, scheduled time and
 * allow-unsealed flag included. Rendering them side by side is what keeps that
 * property visible.
 *
 * This component owns no decision. It is pure plumbing: the guards live in
 * their composables, the send lives in the composer, and everything here
 * either forwards an open state or re-emits a confirmation.
 */
import type { Id } from '@owlat/api/dataModel';
import type { SealState } from '~/utils/sealComposer';

defineProps<{
	/** Scopes the schedule dialog's recipient-timezone read. */
	mailboxId?: Id<'mailboxes'>;
	/** To + Cc + Bcc: the dialog only offers a zone when they all share one. */
	recipients: string[];
	/** Sealed Mail (E5): the proceed-or-cancel prompt for an unsealable draft. */
	sealConfirmOpen: boolean;
	sealState: SealState | null;
	/** Team-inbox collision: who replied to this thread after the draft opened. */
	staleReplyByName: string | null;
}>();

const scheduleOpen = defineModel<boolean>('scheduleOpen', { required: true });
const staleOpen = defineModel<boolean>('staleOpen', { required: true });

defineEmits<{
	/** A chosen send time; the composer replays its send with it. */
	schedule: [timestamp: number];
	'update:sealConfirmOpen': [value: boolean];
	confirmUnsealed: [];
	confirmStale: [];
}>();
</script>

<template>
	<!-- Plan idea 9: the recipients drive the timezone-aware presets. To/Cc/Bcc
	     together, since the dialog only speaks up when they share ONE zone. -->
	<PostboxScheduleDialog
		v-model:open="scheduleOpen"
		:mailbox-id="mailboxId"
		:recipients="recipients"
		@confirm="(ts: number) => $emit('schedule', ts)"
	/>
	<!-- Sealed Mail (E5): the decision behind every unsealed send; confirming
	     replays the parked send (scheduled time included) as an explicit act. -->
	<PostboxComposerSealConfirmDialog
		:open="sealConfirmOpen"
		:seal-state="sealState"
		@update:open="$emit('update:sealConfirmOpen', $event)"
		@confirm="$emit('confirmUnsealed')"
	/>
	<!-- Team-inbox collision safety: a teammate replied to this thread after
	     this reply was opened. Confirm before sending a duplicate. -->
	<PostboxStaleReplyDialog
		v-model:open="staleOpen"
		:reply-by-name="staleReplyByName"
		@confirm="$emit('confirmStale')"
	/>
</template>
