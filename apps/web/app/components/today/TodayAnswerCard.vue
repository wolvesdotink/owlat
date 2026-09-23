<script setup lang="ts">
import type { AnswerItem } from '~/composables/useAnswerQueue';
import { replyQueueHeadline, type ReplyQueueText } from '~/utils/postboxReplyQueue';

/**
 * Today's first band: how many things wait on the viewer's answer, one button
 * into the Answer queue, and the top three as sentences. A row opens the queue
 * at that card, not the raw thread — answering happens in one place.
 */
const props = defineProps<{
	items: readonly AnswerItem[];
	counts: { mail: number; team: number; mention: number; drafts: number };
	isLoading: boolean;
}>();

const { t } = useI18n();
const TOP = 3;
const top = computed(() => props.items.slice(0, TOP));
/** A rough reading-and-replying budget: ~90 seconds a card. */
const minutes = computed(() => Math.max(1, Math.round(props.items.length * 1.5)));

function text(value: ReplyQueueText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

function rowTitle(item: AnswerItem): string {
	if (item.source === 'mail') return text(replyQueueHeadline(item.row));
	if (item.source === 'team') return item.entry.message.subject || t('components.shell.noSubject');
	return t('components.today.answer.mentionTitle', {
		room: item.mention.roomName,
		preview: item.mention.messagePreview,
	});
}
function rowDetail(item: AnswerItem): string {
	if (item.source === 'mail') return item.row.fromName || item.row.fromAddress;
	if (item.source === 'team') return item.entry.message.from;
	return '';
}
function rowMeta(item: AnswerItem): string {
	const when = formatCompactRelativeTime(item.at);
	if (item.source === 'mail' && item.row.draftSlot)
		return `${when} · ${t('components.today.answer.draftReady')}`;
	if (item.source === 'team' && item.entry.message.draftResponse?.trim()) {
		return `${when} · ${t('components.today.answer.draftReady')}`;
	}
	if (item.source === 'mention') return `${when} · ${t('components.today.answer.mention')}`;
	return when;
}

const breakdown = computed(() => {
	const parts: string[] = [];
	if (props.counts.drafts > 0)
		parts.push(
			t('components.today.answer.drafts', { count: props.counts.drafts }, props.counts.drafts)
		);
	if (props.counts.mail > 0)
		parts.push(t('components.today.answer.mail', { count: props.counts.mail }, props.counts.mail));
	if (props.counts.team > 0)
		parts.push(t('components.today.answer.team', { count: props.counts.team }, props.counts.team));
	if (props.counts.mention > 0)
		parts.push(
			t('components.today.answer.mentions', { count: props.counts.mention }, props.counts.mention)
		);
	parts.push(t('components.today.answer.minutes', { count: minutes.value }, minutes.value));
	return parts.join(' · ');
});
</script>

<template>
	<section :aria-labelledby="'today-answer'">
		<div
			v-if="isLoading && items.length === 0"
			class="flex items-center gap-4 rounded-2xl border border-border-subtle bg-bg-elevated px-5 py-4"
		>
			<UiSkeleton class="size-9 rounded-lg" />
			<div class="flex-1 space-y-2">
				<UiSkeleton class="h-4 w-56" />
				<UiSkeleton class="h-3 w-72" />
			</div>
		</div>

		<div
			v-else-if="items.length > 0"
			class="flex flex-wrap items-center gap-4 rounded-2xl border border-border-subtle bg-bg-elevated px-5 py-4 shadow-(--shadow-1)"
		>
			<span
				class="font-display text-4xl leading-none tracking-tight text-text-primary tabular-nums"
				>{{ items.length }}</span
			>
			<div class="min-w-0 flex-1">
				<h2 id="today-answer" class="text-sm font-medium text-text-primary">
					{{ t('components.today.answer.title', { count: items.length }, items.length) }}
				</h2>
				<p class="mt-0.5 text-xs text-text-secondary">{{ breakdown }}</p>
			</div>
			<UiButton to="/dashboard/answer" class="shrink-0">
				{{ t('components.today.answer.cta') }}
				<Icon name="lucide:arrow-right" class="size-4" />
			</UiButton>
		</div>

		<div
			v-else
			class="flex items-center gap-3 rounded-2xl border border-border-subtle bg-bg-elevated px-5 py-4"
		>
			<Icon name="lucide:check-circle-2" class="size-5 text-success" />
			<div>
				<h2 id="today-answer" class="text-sm font-medium text-text-primary">
					{{ t('components.today.answer.clearTitle') }}
				</h2>
				<p class="text-xs text-text-secondary">{{ t('components.today.answer.clearBody') }}</p>
			</div>
		</div>

		<template v-if="top.length > 0">
			<h3
				class="mb-2 mt-8 flex items-center text-2xs font-medium uppercase tracking-wider text-text-tertiary"
			>
				{{ t('components.today.answer.needsTitle') }}
				<NuxtLink
					to="/dashboard/answer"
					class="ml-auto normal-case tracking-normal text-brand hover:underline"
					>{{ t('components.today.answer.allInQueue', { count: items.length }) }}</NuxtLink
				>
			</h3>
			<ul
				class="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-elevated"
			>
				<li v-for="item in top" :key="item.id">
					<NuxtLink
						:to="`/dashboard/answer?focus=${encodeURIComponent(item.id)}`"
						class="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-bg-surface"
						data-today-line
					>
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm font-medium text-text-primary">{{
								rowTitle(item)
							}}</span>
							<span v-if="rowDetail(item)" class="block truncate text-xs text-text-tertiary">{{
								rowDetail(item)
							}}</span>
						</span>
						<span class="flex shrink-0 flex-col items-end gap-1">
							<InboxChip
								v-if="item.source === 'mail' && item.inbox"
								:name="item.inbox.name"
								:slot="item.inbox.slot"
							/>
							<span
								v-else-if="item.source === 'team'"
								class="inline-flex items-center gap-1 rounded-full bg-bg-surface px-2 py-px text-2xs font-medium text-text-secondary"
								><Icon name="lucide:bot" class="size-3" />{{
									t('components.shell.teamInbox')
								}}</span
							>
							<span
								v-else
								class="inline-flex items-center gap-1 rounded-full bg-bg-surface px-2 py-px text-2xs font-medium text-text-secondary"
								><Icon name="lucide:message-circle" class="size-3" />{{
									t('components.shell.chat.title')
								}}</span
							>
							<span class="text-2xs text-text-tertiary">{{ rowMeta(item) }}</span>
						</span>
					</NuxtLink>
				</li>
			</ul>
		</template>
	</section>
</template>
