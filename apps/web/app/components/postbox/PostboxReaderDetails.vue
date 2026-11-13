<script setup lang="ts">
/**
 * The thread half of the calm reader's Details row (read on arrival §3): what
 * used to stand between the subject and the mail. The follow-up chip, the
 * team badge, the labels and the same conversation on the other surface. The
 * latest message's own chips (trust, unsubscribe, delivery, scheduling,
 * images) are teleported in beside these by its card.
 */
import type { Id } from '@owlat/api/dataModel';

defineProps<{
	messageId: Id<'mailMessages'>;
	thread?: {
		_id: string;
		followUp?: { messageId: string; remindAt: number; dueAt?: number; waitingOn?: string };
	} | null;
	latestOutboundId?: string;
	labelIds: string[];
	labels: Map<string, { _id: string; name: string; color?: string }>;
}>();

// A label's colour is the user's pick, so it can be any lightness. It marks the
// dot only; the name is set in a text token on a neutral chip, which stays
// readable whichever colour was picked and in either theme.
</script>

<template>
	<PostboxFollowUpChip v-if="thread" :thread="thread" :latest-outbound-id="latestOutboundId" />
	<PostboxTeamReplyBadge :message-id="messageId" />
	<div
		v-if="labelIds.length > 0"
		class="flex flex-wrap items-center gap-1.5"
		data-testid="reader-details-labels"
	>
		<span
			v-for="labelId in labelIds"
			:key="labelId"
			class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-bg-surface text-text-secondary"
		>
			<span
				class="w-1.5 h-1.5 rounded-full"
				:class="{ 'bg-text-tertiary': !labels.get(labelId)?.color }"
				:style="
					labels.get(labelId)?.color ? { backgroundColor: labels.get(labelId)?.color } : undefined
				"
				aria-hidden="true"
			/>
			{{ labels.get(labelId)?.name }}
		</span>
	</div>
	<!-- The same conversation, seen from the other surface (idea 31). -->
	<PostboxCrossSurfaceStrip :message-id="messageId" />
</template>
