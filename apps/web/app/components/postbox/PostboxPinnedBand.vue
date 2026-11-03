<script setup lang="ts">
/**
 * The Inbox's pinned band: up to five conversations kept at the top until
 * someone unpins them (mail/pins.ts). Browse shows it above whichever list
 * renderer is active, and the Priority column shows it under its header, so
 * a pinned conversation is one click away in every inbox view.
 *
 * The band reads its own query, not the list's pages, so a pinned thread
 * whose mail is old or already archived still shows. Pinned rows stay in the
 * list below as well: the list is the mail in order, the band a shortcut.
 *
 * Dropping dragged rows onto the band pins their conversations. While a drag
 * is in flight an empty band appears as the drop target, and a full one says
 * so and refuses the drop.
 */
import { NuxtLink } from '#components';
import type { Id } from '@owlat/api/dataModel';
import { usePostboxMessageDropTargets } from '~/composables/postbox/usePostboxMessageDrag';
import {
	usePostboxListNow,
	usePostboxThreadTimestamp,
} from '~/composables/postbox/usePostboxListClock';
import {
	usePostboxPinAction,
	usePostboxPinnedConversations,
	type PostboxPinnedConversation,
} from '~/composables/postbox/usePostboxPins';
import { PinIcon, PinOffIcon } from '@coolicons/vue';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	/**
	 * Open entries in place (`select`) instead of navigating (the Priority
	 * column), with `activeMessageId` marking the open one. A navigating band
	 * marks its open entry through the link's own active state.
	 */
	selectable?: boolean;
	activeMessageId?: string | null;
	/** A bordered card, as the Priority column's sections are. */
	framed?: boolean;
}>();

const emit = defineEmits<{
	select: [messageId: string];
}>();

const { t } = useI18n();
const mailboxIdRef = computed(() => props.mailboxId);
const { conversations, limit, isFull } = usePostboxPinnedConversations(mailboxIdRef);
const pins = usePostboxPinAction();
const drop = usePostboxMessageDropTargets(mailboxIdRef);
const formatTimestamp = usePostboxThreadTimestamp(usePostboxListNow());

const dropListeners = drop.pin(
	() => !isFull.value,
	(messageIds) => pins.setPinned(messageIds, true)
);
const isShown = computed(() => conversations.value.length > 0 || drop.active.value);

const sender = (c: PostboxPinnedConversation) => c.fromName?.trim() || c.fromAddress;
const subject = (c: PostboxPinnedConversation) =>
	c.subject || t('components.postbox.postboxThreadRow.noSubject');
</script>

<template>
	<section
		v-if="isShown"
		:aria-label="t('postbox.pins.title')"
		data-testid="postbox-pinned-band"
		:class="[
			framed
				? 'rounded-lg border border-border-subtle bg-bg-surface px-2 py-2'
				: 'border-b border-border-subtle px-2 py-2',
			{ 'pbx-drop-target': drop.isOverPin() },
		]"
		v-on="dropListeners"
	>
		<h2
			class="flex items-center gap-1.5 px-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary"
		>
			<PinIcon class="w-3 h-3" aria-hidden="true" />
			{{ t('postbox.pins.title') }}
			<span class="ml-auto font-normal normal-case tracking-normal tabular-nums">{{
				t('postbox.pins.count', { count: conversations.length, limit })
			}}</span>
		</h2>
		<ul v-if="conversations.length > 0" class="mt-1">
			<li
				v-for="c in conversations"
				:key="c.threadId"
				class="group flex items-center gap-1 rounded"
			>
				<component
					:is="selectable ? 'button' : NuxtLink"
					:type="selectable ? 'button' : undefined"
					:to="selectable ? undefined : `/dashboard/postbox/inbox/${c.messageId}`"
					:exact-active-class="selectable ? undefined : 'bg-bg-base'"
					class="flex min-w-0 flex-1 items-baseline gap-2 rounded px-1.5 py-1 text-left text-sm outline-none hover:bg-bg-base focus-visible:ring-1 focus-visible:ring-brand/40"
					:class="{ 'bg-bg-base': selectable && activeMessageId === c.messageId }"
					:aria-current="selectable && activeMessageId === c.messageId ? 'true' : undefined"
					data-testid="postbox-pinned-entry"
					@click="selectable && emit('select', c.messageId)"
				>
					<span
						class="w-1.5 h-1.5 flex-shrink-0 self-center rounded-full"
						:class="c.unreadCount > 0 ? 'bg-brand' : 'bg-transparent'"
						aria-hidden="true"
					/>
					<span
						class="max-w-[40%] flex-shrink-0 truncate"
						:class="c.unreadCount > 0 ? 'font-semibold text-text-primary' : 'text-text-primary'"
						>{{ sender(c) }}</span
					>
					<span class="min-w-0 flex-1 truncate text-text-secondary">{{ subject(c) }}</span>
					<span class="flex-shrink-0 text-xs tabular-nums text-text-tertiary">{{
						formatTimestamp(c.lastMessageAt)
					}}</span>
				</component>
				<UiTooltip :text="t('postbox.pins.unpin')">
					<button
						type="button"
						class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-text-tertiary opacity-0 outline-none hover:bg-bg-base hover:text-text-primary focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-brand/40 group-hover:opacity-100 pointer-coarse:opacity-100"
						:aria-label="t('postbox.pins.unpinNamed', { subject: subject(c) })"
						data-testid="postbox-pinned-unpin"
						@click="pins.setPinned([c.messageId], false)"
					>
						<PinOffIcon class="w-3.5 h-3.5" aria-hidden="true" />
					</button>
				</UiTooltip>
			</li>
		</ul>
		<p
			v-if="drop.active.value && (conversations.length === 0 || isFull)"
			class="mt-1 px-1.5 py-1 text-xs text-text-tertiary"
			role="status"
		>
			{{ isFull ? t('postbox.pins.full') : t('postbox.pins.dropHint') }}
		</p>
	</section>
</template>
