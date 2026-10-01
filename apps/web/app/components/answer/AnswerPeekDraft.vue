<script setup lang="ts">
/**
 * "✦ Draft" beside the resting phone/tablet sheet's "Reply to …" row (the
 * frame's `#peek-actions` slot): open the reply and draft it with AI at once.
 * On a phone the instruction is a chore; the ask card is where the phone user
 * answers.
 */
defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ draft: [] }>();
const { t } = useI18n();
</script>

<template>
	<UiButton
		type="button"
		size="sm"
		variant="ghost"
		class="shrink-0"
		:disabled="disabled"
		data-testid="answer-peek-draft"
		@click="emit('draft')"
	>
		<Icon name="lucide:sparkles" class="mr-1 size-3.5 text-brand" aria-hidden="true" />
		{{ t('components.answer.aiBar.peekDraft') }}
	</UiButton>
</template>
