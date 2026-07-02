<script setup lang="ts">
/**
 * Follow-up ("remind me if no reply") state chip for the thread reader.
 *
 * - armed: "Reply reminder · <date>" chip, click the x to cancel
 * - due (deadline passed, no reply): amber "No reply yet" chip, x dismisses
 * - neither, and the newest message is one we sent: a quiet "Remind me if
 *   no reply" button that arms a watch on that sent message.
 *
 * All mutations are ownership-checked server-side (mail/followUps.ts).
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	thread: {
		_id: string;
		followUp?: {
			messageId: string;
			remindAt: number;
			dueAt?: number;
			waitingOn?: string;
		};
	};
	/** The newest sent message's id when the thread ends on our own mail. */
	latestOutboundId?: string;
}>();

const followUp = computed(() => props.thread.followUp);
const isDue = computed(() => followUp.value?.dueAt !== undefined);

const armOp = useBackendOperation(api.mail.followUps.arm, { label: 'Set reply reminder' });
const cancelOp = useBackendOperation(api.mail.followUps.cancel, {
	label: 'Cancel reply reminder',
});

const dialogOpen = ref(false);
const busy = ref(false);

async function armAt(remindAt: number) {
	const messageId = props.latestOutboundId;
	if (!messageId || busy.value) return;
	busy.value = true;
	try {
		await armOp.run({ messageId: messageId as Id<'mailMessages'>, remindAt });
	} finally {
		busy.value = false;
	}
}

async function cancelWatch() {
	if (busy.value) return;
	busy.value = true;
	try {
		await cancelOp.run({ threadId: props.thread._id as Id<'mailThreads'> });
	} finally {
		busy.value = false;
	}
}

const remindLabel = computed(() =>
	followUp.value ? formatDateTime(followUp.value.remindAt) : ''
);
</script>

<template>
	<div class="flex items-center">
		<!-- Deadline passed with no reply -->
		<span
			v-if="followUp && isDue"
			class="inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-full bg-warning/10 text-warning text-xs font-medium"
		>
			<Icon name="lucide:alarm-clock" class="w-3.5 h-3.5" />
			No reply yet{{ followUp.waitingOn ? ` — waiting on ${followUp.waitingOn}` : '' }}
			<button
				type="button"
				class="p-0.5 rounded-full hover:bg-warning/20"
				title="Dismiss reminder"
				aria-label="Dismiss reminder"
				:disabled="busy"
				@click="cancelWatch"
			>
				<Icon name="lucide:x" class="w-3 h-3" />
			</button>
		</span>
		<!-- Armed and waiting -->
		<span
			v-else-if="followUp"
			class="inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-full bg-brand/10 text-brand text-xs font-medium"
			:title="`You'll be reminded if nobody replies by ${remindLabel}`"
		>
			<Icon name="lucide:alarm-clock" class="w-3.5 h-3.5" />
			Reply reminder · {{ remindLabel }}
			<button
				type="button"
				class="p-0.5 rounded-full hover:bg-brand/20"
				title="Cancel reminder"
				aria-label="Cancel reminder"
				:disabled="busy"
				@click="cancelWatch"
			>
				<Icon name="lucide:x" class="w-3 h-3" />
			</button>
		</span>
		<!-- Not armed; the thread ends on our own sent mail -->
		<button
			v-else-if="latestOutboundId"
			type="button"
			class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-border-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-elevated"
			title="Remind me if no reply"
			:disabled="busy"
			@click="dialogOpen = true"
		>
			<Icon name="lucide:alarm-clock" class="w-3.5 h-3.5" />
			Remind me if no reply
		</button>

		<PostboxFollowUpDialog
			:open="dialogOpen"
			@update:open="dialogOpen = $event"
			@confirm="armAt"
		/>
	</div>
</template>
