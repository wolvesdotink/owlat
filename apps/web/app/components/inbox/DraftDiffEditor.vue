<script setup lang="ts">
/**
 * Edit an agent draft with a live before/after diff.
 *
 * The review gate used to drop the reviewer into a bare textarea that REPLACED
 * the agent's text, so there was no way to see what actually changed before it
 * became the outgoing draft. This component keeps the original draft in view: as
 * the reviewer types, the original (struck through) and their edit (emphasized)
 * are shown side by side, reusing the original-vs-rewritten presentation from
 * {@link PostboxRewritePreview} (no diff library). Apply commits the edit;
 * Discard reverts the text back to the original. Nothing is ever auto-applied —
 * the edited text only leaves this component through an explicit Apply.
 *
 * Plain-text bodies only (rich-HTML diffing is out of scope).
 */

const props = withDefaults(
	defineProps<{
		/** The draft as it stands before this edit — the "before" of the diff. */
		original: string;
		/** The reviewer's working edit (two-way). */
		modelValue: string;
		/** Disable Apply while the edit is being persisted. */
		saving?: boolean;
		/** Label for the primary commit button. */
		applyLabel?: string;
	}>(),
	{
		saving: false,
		applyLabel: 'Save & Approve',
	},
);

const emit = defineEmits<{
	(e: 'update:modelValue', value: string): void;
	(e: 'apply'): void;
	(e: 'discard'): void;
}>();

// Trim-insensitive so pure whitespace churn does not flag as an "edit".
const hasChanges = computed(() => props.original.trim() !== props.modelValue.trim());

function onInput(event: Event) {
	emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
}

// Discard puts the original text back and lets the parent close the editor.
function onDiscard() {
	emit('update:modelValue', props.original);
	emit('discard');
}
</script>

<template>
	<div class="space-y-3">
		<textarea
			:value="modelValue"
			rows="8"
			class="input w-full text-sm resize-y"
			aria-label="Edit draft response"
			@input="onInput"
		/>

		<!-- Before/after diff — only once the edit diverges from the original. -->
		<div
			v-if="hasChanges"
			class="rounded-lg border border-border-subtle bg-bg-elevated p-3"
			data-testid="draft-diff"
		>
			<p class="mb-1 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
				Original draft
			</p>
			<p
				class="mb-3 max-h-32 overflow-auto whitespace-pre-wrap text-xs text-text-tertiary line-through decoration-1"
				data-testid="draft-diff-original"
			>
				{{ original }}
			</p>
			<p class="mb-1 text-[11px] font-medium uppercase tracking-wide text-brand">
				Your edit
			</p>
			<p
				class="max-h-40 overflow-auto whitespace-pre-wrap text-sm text-text-primary"
				data-testid="draft-diff-edited"
			>
				{{ modelValue }}
			</p>
		</div>

		<div class="flex items-center gap-2">
			<button
				type="button"
				class="btn btn-primary btn-sm gap-1"
				:disabled="saving"
				data-testid="draft-diff-apply"
				@click="emit('apply')"
			>
				<Icon name="lucide:save" class="w-3 h-3" />
				{{ applyLabel }}
			</button>
			<button
				type="button"
				class="btn btn-ghost btn-sm"
				:disabled="saving"
				data-testid="draft-diff-discard"
				@click="onDiscard"
			>
				Discard
			</button>
		</div>
	</div>
</template>
