<script setup lang="ts">
/**
 * Prompt-on-insert for snippet variables (plan idea 13).
 *
 * A snippet can declare variables whose only source is the person inserting it
 * — the ticket number, the meeting link, the one figure a canned response
 * cannot know. When such a snippet is chosen the picker parks it here (the "/"
 * trigger is already consumed, so the caret is exactly where the body goes) and
 * the insert completes once these fields are answered.
 *
 * Cancelling inserts nothing. A half-filled canned response the sender backed
 * out of is worse than no insert at all — and every unanswered field would then
 * ship as a visible `{{token}}` anyway.
 */
import type { SnippetPromptRequest } from '~/composables/postbox/usePostboxSnippetPicker';

const props = defineProps<{
	/** The parked snippet and the fields it needs, or null when idle. */
	request: SnippetPromptRequest | null;
}>();

const emit = defineEmits<{
	(e: 'submit', answers: Record<string, string>): void;
	(e: 'cancel'): void;
}>();

const { t } = useI18n();

const answers = ref<Record<string, string>>({});

// Each parked snippet starts from a clean slate: carrying the previous
// insert's ticket number into the next one is how a wrong number ships.
watch(
	() => props.request,
	(request) => {
		answers.value = Object.fromEntries((request?.fields ?? []).map((f) => [f.token, '']));
	},
	{ immediate: true }
);

function submit() {
	emit('submit', { ...answers.value });
}
</script>

<template>
	<UiModal
		:open="request !== null"
		size="md"
		:title="t('components.postbox.postboxSnippetVariableDialog.title')"
		@update:open="(open) => !open && emit('cancel')"
	>
		<form class="space-y-3" data-testid="snippet-variable-dialog" @submit.prevent="submit">
			<p class="text-xs text-text-tertiary">
				{{
					t('components.postbox.postboxSnippetVariableDialog.description', {
						name: request?.snippet.name ?? '',
					})
				}}
			</p>
			<label v-for="(field, i) in request?.fields ?? []" :key="field.token" class="block">
				<span class="mb-1 block text-sm text-text-secondary">
					{{ field.label?.trim() || field.token }}
				</span>
				<input
					v-model="answers[field.token]"
					type="text"
					class="input w-full"
					:autofocus="i === 0"
					:placeholder="`{{${field.token}}}`"
				/>
			</label>
			<div class="flex items-center justify-end gap-2">
				<UiButton variant="ghost" type="button" @click="emit('cancel')">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton type="submit">
					{{ t('components.postbox.postboxSnippetVariableDialog.insert') }}
				</UiButton>
			</div>
		</form>
	</UiModal>
</template>
