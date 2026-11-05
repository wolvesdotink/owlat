<script setup lang="ts">
/**
 * The pane's Drafts row: shown while anything is unsent, folded to one line
 * so a pile of drafts never pushes the people out of view. Unfolded, each
 * draft names whom it goes to, what about and when it was last saved. A
 * reply draft is continued where replies are written (Answer mode, on the
 * message it answers); a new message on the compose page.
 */
import type { Id } from '@owlat/api/dataModel';
import { CaretDownIcon, CaretRightIcon, FileEditIcon } from '@coolicons/vue';
import { useAnswerModeNav } from '~/composables/useAnswerMode';
import { usePostboxThreadTimestamp } from '~/composables/postbox/usePostboxListClock';

import type { PaneDraft as Draft } from '~/utils/postboxConversations';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	drafts: readonly Draft[];
	/** A display name for an address, where the directory knows one. */
	nameOf: (address: string) => string;
}>();

const { t } = useI18n();
const stamp = usePostboxThreadTimestamp();
const isOpen = ref(false);
const composeNav = usePostboxComposeNav();
const answerNav = useAnswerModeNav();

function open(draft: Draft) {
	if (draft.inReplyToMessageId) {
		void answerNav.open(draft.inReplyToMessageId, { draftId: draft._id });
		return;
	}
	void composeNav.open({ mailboxId: props.mailboxId, draftId: draft._id as Id<'mailDrafts'> });
}
function recipients(draft: Draft): string {
	const [first, ...rest] = draft.toAddresses;
	if (!first) return t('components.postbox.conversations.drafts.noRecipient');
	const name = props.nameOf(first);
	return rest.length > 0 ? `${name} +${rest.length}` : name;
}
</script>

<template>
	<div v-if="drafts.length > 0">
		<button
			type="button"
			data-pane-row
			class="flex min-h-12 w-full items-center gap-3 px-4 text-left hover:bg-bg-surface-hover"
			:aria-expanded="isOpen"
			@click="isOpen = !isOpen"
		>
			<span
				class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-bg-soft text-text-secondary"
				aria-hidden="true"
			>
				<FileEditIcon class="h-4 w-4" />
			</span>
			<span class="flex-1 text-[0.9375rem] font-medium text-text-primary">
				{{ t('components.postbox.conversations.drafts.title') }}
				<span class="ml-1 font-normal text-text-tertiary">{{ drafts.length }}</span>
			</span>
			<CaretDownIcon v-if="isOpen" class="h-3.5 w-3.5 text-text-tertiary" />
			<CaretRightIcon v-else class="h-3.5 w-3.5 text-text-tertiary" />
		</button>
		<ul v-if="isOpen" class="pb-1">
			<li v-for="draft in drafts" :key="draft._id">
				<button
					type="button"
					data-pane-row
					class="flex w-full items-baseline gap-2 py-2 pl-16 pr-4 text-left hover:bg-bg-surface-hover"
					@click="open(draft)"
				>
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm font-medium text-text-primary">{{
							recipients(draft)
						}}</span>
						<span class="block truncate text-[0.8125rem] text-text-secondary">{{
							draft.subject || t('components.postbox.conversations.drafts.noSubject')
						}}</span>
					</span>
					<span class="flex-shrink-0 text-xs text-text-tertiary">{{
						draft.state === 'scheduled'
							? t('components.postbox.conversations.drafts.scheduled')
							: stamp(draft.lastEditedAt)
					}}</span>
				</button>
			</li>
		</ul>
	</div>
</template>
