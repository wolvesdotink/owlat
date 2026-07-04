<script setup lang="ts">
/**
 * Attachment suggestion chip at the review gate.
 *
 * When an inbound asks for a document ("can you send X" / "see attached") and the
 * `draft` Agent step found a contact-scoped `semanticFiles` match
 * (apps/api/convex/agent/steps/draft + inbox/attachmentSuggest.ts), it persists
 * an advisory `attachmentSuggestions` block on the message. This presentational
 * component renders it as a one-tap "attach <file>?" — a SINGLE confident
 * suggestion, or, when the match was genuinely ambiguous, a pick-one shortlist
 * (the agent never guesses which file; the human confirms). The parent owns what
 * "attach" does — this component only proposes and emits.
 *
 * Attachment is HUMAN-CONFIRMED only: the autonomous send path never attaches
 * (recipient-lock forbids a new attachment on an unattended reply), so this chip
 * only ever appears on the human review surface.
 */

interface AttachmentCandidate {
	fileId: string;
	storageId: string;
	filename: string;
	title?: string;
	mimeType: string;
	fileSize: number;
	score: number;
}

const props = defineProps<{
	suggestions: {
		query: string;
		ambiguous: boolean;
		candidates: AttachmentCandidate[];
	};
}>();

const emit = defineEmits<{ attach: [candidate: AttachmentCandidate] }>();

/** Prefer a human title over the raw filename for the chip label. */
function label(candidate: AttachmentCandidate): string {
	return candidate.title?.trim() || candidate.filename;
}
</script>

<template>
	<div class="bg-brand-subtle/20 border border-brand/20 rounded-lg p-3">
		<div class="flex items-center gap-2 mb-2">
			<Icon name="lucide:paperclip" class="w-4 h-4 text-brand" />
			<p class="text-xs font-medium text-brand uppercase tracking-wider">
				{{ props.suggestions.ambiguous ? 'Attach a file — pick one' : 'Suggested attachment' }}
			</p>
		</div>

		<!-- Single confident suggestion → one-tap attach. -->
		<button
			v-if="!props.suggestions.ambiguous && props.suggestions.candidates.length === 1"
			type="button"
			class="btn btn-secondary btn-sm gap-1"
			data-testid="attach-suggestion"
			@click="emit('attach', props.suggestions.candidates[0]!)"
		>
			<Icon name="lucide:paperclip" class="w-3 h-3" />
			Attach {{ label(props.suggestions.candidates[0]!) }}
		</button>

		<!-- Ambiguous → the owner picks which file (no guessing). -->
		<div v-else class="flex flex-col gap-2">
			<p class="text-xs text-text-secondary">
				Several files could match — choose the one to attach:
			</p>
			<div class="flex flex-wrap gap-2">
				<button
					v-for="candidate in props.suggestions.candidates"
					:key="candidate.fileId"
					type="button"
					class="btn btn-secondary btn-sm gap-1"
					data-testid="attach-suggestion"
					@click="emit('attach', candidate)"
				>
					<Icon name="lucide:paperclip" class="w-3 h-3" />
					{{ label(candidate) }}
				</button>
			</div>
		</div>
	</div>
</template>
