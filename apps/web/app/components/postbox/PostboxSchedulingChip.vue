<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { useSuggestReplies } from '~/composables/postbox/useSuggestReplies';

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
const { t } = useI18n();

const props = defineProps<{
	messageId: string;
	proposedTimes: string[];
}>();

const emit = defineEmits<{
	(e: 'use-reply', text: string): void;
	(e: 'dismiss'): void;
}>();

// Options stream in one by one; the one still being written can't be picked yet.
const {
	replies,
	readyCount,
	busy: suggestBusy,
	run: runSuggest,
} = useSuggestReplies({
	label: () => t('components.postbox.postboxSchedulingChip.draftOperation'),
});

async function draft() {
	await runSuggest({
		messageId: props.messageId as Id<'mailMessages'>,
		focus: 'scheduling',
		proposedTimes: props.proposedTimes,
	});
}
</script>

<template>
	<div class="mt-1.5">
		<div class="flex items-center gap-1.5">
			<UiButton
				variant="outline"
				size="sm"
				class="gap-1.5 px-2.5 py-1 text-xs"
				:disabled="suggestBusy"
				@click="draft"
			>
				<template #iconLeft>
					<Icon
						:name="suggestBusy ? 'lucide:loader-2' : 'lucide:calendar-clock'"
						class="w-3.5 h-3.5"
						:class="{ 'animate-spin motion-reduce:animate-none': suggestBusy }"
					/>
				</template>
				{{ t('components.postbox.postboxSchedulingChip.prompt') }}
			</UiButton>
			<button
				type="button"
				class="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface"
				:title="t('common.dismiss')"
				:aria-label="t('components.postbox.postboxSchedulingChip.dismissLabel')"
				@click="emit('dismiss')"
			>
				<Icon name="lucide:x" class="w-3.5 h-3.5" />
			</button>
		</div>

		<div aria-live="polite" :aria-busy="suggestBusy">
			<span v-if="suggestBusy" class="sr-only">{{
				t('components.postbox.postboxSchedulingChip.drafting')
			}}</span>
			<div
				v-if="replies.length > 0"
				role="group"
				:aria-label="t('components.postbox.postboxSchedulingChip.repliesLabel')"
				class="mt-2 flex flex-wrap gap-2"
			>
				<button
					v-for="(r, i) in replies"
					:key="i"
					type="button"
					class="text-left text-xs px-3 py-2 rounded-lg border border-border-subtle hover:border-brand hover:bg-bg-surface max-w-xs disabled:opacity-60 disabled:pointer-events-none"
					:disabled="i >= readyCount"
					@click="emit('use-reply', r)"
				>
					{{ r }}
				</button>
			</div>
		</div>
	</div>
</template>
