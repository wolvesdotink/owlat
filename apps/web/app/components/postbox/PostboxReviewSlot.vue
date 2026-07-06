<script setup lang="ts">
import InboxTrustChip from '~/components/inbox/TrustChip.vue';
import type { ReplyQueueDraftSlot } from '~/utils/postboxReplyQueue';
import { trustLabel } from '~/utils/trustLabel';

/**
 * Draft-on-arrival review slot (postbox.aiDraft).
 *
 * Renders under a Reply Queue row when the shared draft service pre-generated a
 * reply the moment the message landed: a "Draft ready" chip, a human trust chip
 * ("Ready to send" / "Worth a look" / "Needs you" — never raw confidence
 * percentages; the self-check flags become plain-language reasons in the chip's
 * popover), a preview of the draft, and a keyboard-first "Review & send" action
 * that opens the composer prefilled.
 *
 * HUMAN REVIEW ONLY: this surface never sends. It emits `review` (open the
 * composer with the draft) and `dismiss` (drop the slot from view).
 */
const props = defineProps<{ draftSlot: ReplyQueueDraftSlot }>();
const emit = defineEmits<{
	(e: 'review', draft: string): void;
	(e: 'dismiss'): void;
}>();

// A failed self-check (no quality) reads "Needs you", conservatively — the old
// "Unverified" state in human words. The score + flags otherwise map to the
// three trust states; the raw number survives as the popover's quiet footer.
const trust = computed(() =>
	trustLabel(
		props.draftSlot.quality ? props.draftSlot.confidence : null,
		props.draftSlot.quality?.flags ?? []
	)
);

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
			<InboxTrustChip data-testid="review-slot-confidence" :trust="trust" />
			<span
				v-if="draftSlot.options && draftSlot.options.length > 1"
				class="text-[10px] text-text-tertiary"
				data-testid="review-slot-options"
			>
				{{ draftSlot.options.length }} options
			</span>
		</div>

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
