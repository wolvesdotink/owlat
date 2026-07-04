<script setup lang="ts">
import { draftSlotConfidence, type ReplyQueueDraftSlot } from '~/utils/postboxReplyQueue';

/**
 * Draft-on-arrival review slot (postbox.aiDraft).
 *
 * Renders under a Reply Queue row when the shared draft service pre-generated a
 * reply the moment the message landed: a "Draft ready" chip, a confidence badge
 * (the quality self-check score — or "Unverified" when the check failed), the
 * self-check flags a reviewer should skim, a preview of the draft, and a
 * keyboard-first "Review & send" action that opens the composer prefilled.
 *
 * HUMAN REVIEW ONLY: this surface never sends. It emits `review` (open the
 * composer with the draft) and `dismiss` (drop the slot from view).
 */
const props = defineProps<{ draftSlot: ReplyQueueDraftSlot }>();
const emit = defineEmits<{
	(e: 'review', draft: string): void;
	(e: 'dismiss'): void;
}>();

const confidence = computed(() => draftSlotConfidence(props.draftSlot));

const CONFIDENCE_CLASS: Record<string, string> = {
	high: 'bg-success/10 text-success',
	medium: 'bg-brand/10 text-brand',
	low: 'bg-warning/10 text-warning',
	unverified: 'bg-bg-elevated text-text-tertiary',
};

/** Trimmed preview so a long draft doesn't blow up the row. */
const preview = computed(() => {
	const body = props.draftSlot.draft.trim();
	return body.length > 240 ? `${body.slice(0, 240)}…` : body;
});
</script>

<template>
	<div
		data-testid="review-slot"
		class="mt-2 rounded-lg border border-border-subtle bg-bg-elevated/60 p-3"
	>
		<div class="flex items-center gap-2">
			<span
				class="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-px rounded-full bg-brand/10 text-brand"
			>
				<Icon name="lucide:sparkles" class="w-3 h-3" aria-hidden="true" />
				Draft ready
			</span>
			<span
				data-testid="review-slot-confidence"
				class="text-[10px] font-medium uppercase tracking-wide px-1.5 py-px rounded-full"
				:class="CONFIDENCE_CLASS[confidence.level]"
			>
				{{ confidence.label }}
			</span>
			<span
				v-if="draftSlot.options && draftSlot.options.length > 1"
				class="text-[10px] text-text-tertiary"
				data-testid="review-slot-options"
			>
				{{ draftSlot.options.length }} options
			</span>
		</div>

		<!-- Self-check flags a reviewer should skim before sending. -->
		<ul
			v-if="draftSlot.quality && draftSlot.quality.flags.length > 0"
			class="mt-1.5 flex flex-wrap gap-1"
			data-testid="review-slot-flags"
		>
			<li
				v-for="flag in draftSlot.quality.flags"
				:key="flag"
				class="text-[10px] px-1.5 py-px rounded-full bg-warning/10 text-warning"
			>
				{{ flag }}
			</li>
		</ul>

		<p class="mt-1.5 text-xs text-text-secondary whitespace-pre-line line-clamp-3">
			{{ preview }}
		</p>

		<div class="mt-2 flex items-center gap-2">
			<button
				type="button"
				data-testid="review-slot-send"
				class="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-brand text-white hover:bg-brand/90"
				@click.stop.prevent="emit('review', draftSlot.draft)"
			>
				<Icon name="lucide:send" class="w-3.5 h-3.5" aria-hidden="true" />
				Review &amp; send
			</button>
			<button
				type="button"
				data-testid="review-slot-dismiss"
				class="px-2 py-1 rounded text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-surface"
				@click.stop.prevent="emit('dismiss')"
			>
				Dismiss
			</button>
		</div>
	</div>
</template>
