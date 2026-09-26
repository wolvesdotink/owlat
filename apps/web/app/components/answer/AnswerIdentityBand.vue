<script setup lang="ts">
import type { AnswerItem } from '~/composables/useAnswerQueue';
import { INBOX_SLOT_SWATCH } from '~/utils/inboxIdentity';

/**
 * The band above every Answer-queue card that says who the reply goes out
 * as — "Answering as Support · support@…" — and what kind of task it is. The
 * colour matches the inbox's chip everywhere else; the text carries the same
 * information for anyone who cannot rely on the colour.
 */
const props = defineProps<{ item: AnswerItem }>();
const { t } = useI18n();

const band = computed(() => {
	const item = props.item;
	if (item.source === 'mail') {
		const inbox = item.inbox;
		const kind =
			item.row.kind === 'followup'
				? t('components.answer.band.followUp')
				: item.row.draftSlot
					? t('components.answer.band.draftReady')
					: item.row.clarification
						? t('components.answer.band.question')
						: t('components.answer.band.needsReply');
		return {
			label: t('components.answer.band.answeringAs', { name: inbox?.name ?? '' }),
			detail: inbox?.address ?? '',
			kind,
			swatch: inbox && inbox.slot !== null ? INBOX_SLOT_SWATCH[inbox.slot] : 'bg-text-tertiary',
			icon: null as string | null,
		};
	}
	if (item.source === 'team') {
		return {
			label: t('components.answer.band.answeringAs', { name: t('components.shell.teamInbox') }),
			detail: t('components.answer.band.teamDetail'),
			kind: item.entry.message.draftResponse?.trim()
				? t('components.answer.band.draftReady')
				: t('components.answer.band.escalation'),
			swatch: null,
			icon: 'lucide:bot',
		};
	}
	return {
		label: t('components.answer.band.replyingIn', { room: item.mention.roomName }),
		detail: t('components.answer.band.chatDetail'),
		kind: t('components.answer.band.mention'),
		swatch: null,
		icon: 'lucide:message-circle',
	};
});
</script>

<template>
	<div
		class="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border-subtle bg-bg-elevated px-4 py-2.5 text-xs"
		data-testid="answer-identity"
	>
		<span
			v-if="band.swatch"
			class="size-2.5 shrink-0 rounded-[3px]"
			:class="band.swatch"
			aria-hidden="true"
		/>
		<Icon v-else-if="band.icon" :name="band.icon" class="size-3.5 shrink-0 text-text-tertiary" />
		<span class="font-medium text-text-primary">{{ band.label }}</span>
		<span v-if="band.detail" class="truncate text-text-tertiary">{{ band.detail }}</span>
		<span class="ml-auto rounded-full bg-bg-surface px-2 py-0.5 text-text-secondary">{{
			band.kind
		}}</span>
	</div>
</template>
