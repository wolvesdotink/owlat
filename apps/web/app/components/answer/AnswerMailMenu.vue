<script setup lang="ts">
/**
 * Answer mode's ⋯ for a Postbox reply (plan §09): what the reader offers that
 * is still worth a click while answering, so the person does not have to leave
 * the reply for it.
 *
 *  - Open in Postbox: the conversation in the reader, everything included.
 *  - Ask about this thread: the reader's grounded Q&A; the page shows it above
 *    the conversation (`ask`).
 *  - Add label: the reader's label picker on the message answered; the labels
 *    already on it are marked, and picking one of those takes it off.
 */
import type { Id } from '@owlat/api/dataModel';
import { usePostboxLabels } from '~/composables/postbox/usePostboxLabels';

const props = defineProps<{
	messageId: string;
	mailboxId: string | null;
	/** AI is on: "Ask about this thread" is offered. */
	canAsk: boolean;
	/** Labels already on the message: the picker marks them, and picking one takes it off. */
	labelIds?: readonly string[];
}>();

const emit = defineEmits<{ ask: [] }>();

const { t } = useI18n();

const { labels, setOnMessage } = usePostboxLabels(
	computed(() => props.mailboxId as Id<'mailboxes'> | null)
);
// A sibling of the menu, not its slot content: the panel unmounts on the
// click that opens the dialog.
const labelOpen = ref(false);
async function toggleLabel(labelId: Id<'mailLabels'>) {
	labelOpen.value = false;
	const on = (props.labelIds ?? []).includes(labelId);
	await setOnMessage(props.messageId as Id<'mailMessages'>, labelId, !on);
}

const item = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-bg-surface';
</script>

<template>
	<PostboxOverflowMenu :label="t('components.answer.mode.more')" align="right">
		<template #default="{ close }">
			<NuxtLink
				:to="`/dashboard/postbox/inbox/${messageId}`"
				role="menuitem"
				:class="item"
				@click="close()"
			>
				<Icon name="lucide:mail-open" class="size-4 text-text-tertiary" />
				{{ t('components.answer.mode.openInPostbox') }}
			</NuxtLink>
			<button
				v-if="canAsk"
				type="button"
				role="menuitem"
				:class="item"
				data-testid="answer-menu-ask"
				@click="
					close();
					emit('ask');
				"
			>
				<Icon name="lucide:sparkles" class="size-4 text-text-tertiary" />
				{{ t('components.postbox.postboxAiStrip.askAbout') }}
			</button>
			<button
				type="button"
				role="menuitem"
				:class="item"
				data-testid="answer-menu-label"
				@click="
					close();
					labelOpen = true;
				"
			>
				<Icon name="lucide:tag" class="size-4 text-text-tertiary" />
				{{ t('components.postbox.postboxLabelPickerDialog.title') }}
			</button>
		</template>
	</PostboxOverflowMenu>
	<PostboxLabelPickerDialog
		:open="labelOpen"
		:labels="labels"
		:selected-ids="labelIds ?? []"
		@update:open="labelOpen = $event"
		@pick="toggleLabel"
	/>
</template>
