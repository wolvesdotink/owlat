<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * Quiet advisory chip shown under the header of a plain-prose scheduling
 * request ("can we meet Tuesday afternoon?"). Detected server-side by the
 * needs-reply refinement pass (thread.needsReply.meetingIntent) and only ever
 * rendered when there is NO .ics invite attached — real calendar invites are
 * handled by PostboxInviteCard.
 *
 * Clicking it asks mail.ai.suggestReplies for scheduling-focused options
 * (accept a proposed time / offer an alternative) and surfaces them as the
 * same reply buttons the general AI-assist uses; picking one opens a prefilled
 * reply the user edits. Advisory + fail-soft: an AI failure just clears the
 * options and leaves the chip.
 */
const props = defineProps<{
	messageId: string;
	proposedTimes: string[];
}>();

const emit = defineEmits<{
	(e: 'use-reply', text: string): void;
	(e: 'dismiss'): void;
}>();

const replies = ref<string[]>([]);

const suggestOp = useBackendOperation(api.mail.ai.suggestReplies, {
	label: 'Draft scheduling reply',
	type: 'action',
});

async function draft() {
	replies.value = [];
	const res = await suggestOp.run({
		messageId: props.messageId as Id<'mailMessages'>,
		focus: 'scheduling',
		proposedTimes: props.proposedTimes,
	});
	if (res) replies.value = res.replies;
}
</script>

<template>
	<div class="mt-1.5">
		<div class="flex items-center gap-1.5">
			<button
				type="button"
				class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-surface disabled:opacity-50"
				:disabled="suggestOp.isLoading.value"
				@click="draft"
			>
				<Icon
					:name="suggestOp.isLoading.value ? 'lucide:loader-2' : 'lucide:calendar-clock'"
					class="w-3.5 h-3.5"
					:class="{ 'animate-spin': suggestOp.isLoading.value }"
				/>
				Scheduling request — draft a reply?
			</button>
			<button
				type="button"
				class="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface"
				title="Dismiss"
				aria-label="Dismiss scheduling suggestion"
				@click="emit('dismiss')"
			>
				<Icon name="lucide:x" class="w-3.5 h-3.5" />
			</button>
		</div>

		<div aria-live="polite" :aria-busy="suggestOp.isLoading.value">
			<span v-if="suggestOp.isLoading.value" class="sr-only">Drafting…</span>
			<div
				v-if="replies.length > 0"
				role="group"
				aria-label="Suggested scheduling replies"
				class="mt-2 flex flex-wrap gap-2"
			>
				<button
					v-for="(r, i) in replies"
					:key="i"
					type="button"
					class="text-left text-xs px-3 py-2 rounded-lg border border-border-subtle hover:border-brand hover:bg-bg-surface max-w-xs"
					@click="emit('use-reply', r)"
				>
					{{ r }}
				</button>
			</div>
		</div>
	</div>
</template>
