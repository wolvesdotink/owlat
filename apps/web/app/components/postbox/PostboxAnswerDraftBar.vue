<script setup lang="ts">
/**
 * "Draft to Jonas saved · Resume": the reply left in Answer mode, offered back
 * on the list it returned to (plan §02, "Leaving never throws work away").
 *
 * One line in the list's banner slot, for the mailbox the draft belongs to.
 * Resume reopens Answer mode on the same draft; the × drops the offer, never
 * the draft (it stays in Drafts). The draft row is read live, so a draft that
 * was sent or discarded somewhere else takes the offer with it.
 */
import { api } from '@owlat/api';
import { answerModeHref } from '~/utils/answerMode';
import { useAnswerLeftDraft } from '~/composables/useAnswerMode';

const { t } = useI18n();
const { left, clear } = useAnswerLeftDraft();

const { data: draft } = useConvexQuery(api.mail.drafts.get, () =>
	left.value ? { draftId: left.value.draftId } : 'skip'
);
watch(draft, (row) => {
	// `null` is an answer (gone, or not ours); `undefined` is still loading.
	if (row === null || (row && row.state !== 'draft')) clear();
});

const resumeHref = computed(() =>
	left.value
		? answerModeHref(left.value.messageId, { kind: left.value.kind, draftId: left.value.draftId })
		: ''
);
</script>

<template>
	<div
		v-if="left"
		class="flex items-center gap-2 border-b border-border-subtle bg-brand/5 px-4 py-2 text-sm"
		role="status"
		data-testid="answer-draft-bar"
	>
		<Icon name="lucide:pen-line" class="size-4 shrink-0 text-brand" />
		<span class="flex-1 truncate text-text-secondary">
			{{ t('components.postbox.postboxAnswerDraftBar.saved', { name: left.recipient }) }}
		</span>
		<NuxtLink :to="resumeHref" class="shrink-0 text-brand hover:underline">
			{{ t('components.postbox.postboxAnswerDraftBar.resume') }}
		</NuxtLink>
		<button
			type="button"
			class="-my-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded text-text-tertiary hover:text-text-primary"
			:aria-label="t('components.postbox.postboxAnswerDraftBar.dismiss')"
			:title="t('components.postbox.postboxAnswerDraftBar.dismiss')"
			@click="clear()"
		>
			<Icon name="lucide:x" class="size-3.5" />
		</button>
	</div>
</template>
