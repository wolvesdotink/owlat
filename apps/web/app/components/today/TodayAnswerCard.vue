<script setup lang="ts">
import type { AnswerItem } from '~/composables/useAnswerQueue';
import { replyQueueHeadline, type ReplyQueueText } from '~/utils/postboxReplyQueue';
import { parseFromHeader } from '~/utils/todayDigest';
import {
	answerEffortParts,
	answerSourceParts,
	type AnswerCounts,
	type SummaryPart,
} from '~/utils/todayAnswerSummary';

/**
 * Today's first band: how many things wait on the viewer's answer, one button
 * into the Answer queue, and the top three as sentences. A row opens the queue
 * at that card, not the raw thread — answering happens in one place.
 */
const props = defineProps<{
	items: readonly AnswerItem[];
	counts: AnswerCounts;
	isLoading: boolean;
}>();

const { t } = useI18n();
const TOP = 3;
const top = computed(() => props.items.slice(0, TOP));

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
	if (item.source === 'team') {
		const from = parseFromHeader(item.entry.message.from);
		return from.name ?? from.address;
	}
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

const say = (parts: SummaryPart[]) =>
	parts.map((part) => t(part.key, { count: part.count }, part.count)).join(' · ');
/** Parts that add up to the big number, by where each item came from. */
const sourceLine = computed(() => say(answerSourceParts(props.counts)));
/** Drafts ready and the time estimate — true across sources, so on their own line. */
const effortLine = computed(() => say(answerEffortParts(props.counts, props.items.length)));
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
			class="flex flex-col gap-4 rounded-2xl border border-border-subtle bg-bg-elevated px-5 py-4 shadow-(--shadow-1) sm:flex-row sm:items-center"
		>
			<div class="flex min-w-0 flex-1 items-center gap-4">
				<span
					class="font-display text-4xl leading-none tracking-tight text-text-primary tabular-nums"
					>{{ items.length }}</span
				>
				<div class="min-w-0 flex-1">
					<h2 id="today-answer" class="text-sm font-medium text-text-primary">
						{{ t('components.today.answer.title', { count: items.length }, items.length) }}
					</h2>
					<p v-if="sourceLine" class="mt-0.5 text-xs text-text-secondary">{{ sourceLine }}</p>
					<p class="mt-0.5 text-xs text-text-tertiary">{{ effortLine }}</p>
				</div>
			</div>
			<UiButton to="/dashboard/answer" class="shrink-0 justify-center">
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
