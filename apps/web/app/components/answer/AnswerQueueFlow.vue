<script setup lang="ts">
import { api } from '@owlat/api';
import AgentTaskFlow from '~/components/agent-tasks/AgentTaskFlow.vue';
import { useTaskFlow } from '~/composables/useTaskFlow';
import type { AnswerItem } from '~/composables/useAnswerQueue';
import { mailAnswerKind, type AnswerCardControls } from '~/utils/answerCard';
import { formatTaskFlowEstimate, type TaskFlowOrderKey } from '~/utils/taskFlow';
import { replyQueueHeadline } from '~/utils/postboxReplyQueue';

/**
 * The Answer queue — one card at a time over everything waiting on the
 * viewer's answer: mail from every inbox they read, the team inbox's agent
 * drafts, chat mentions. Each card says who the reply goes out as. Filter
 * chips narrow it to one inbox (`?in=<mailboxId>`), the team inbox
 * (`?in=team`) or chat (`?in=chat`); `?focus=<id>` opens on a given card.
 * Finishing the queue moves Today's "since you last looked" mark.
 */
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const queue = useAnswerQueue();
const { inboxes } = useInboxes();

const filter = computed(() => (typeof route.query['in'] === 'string' ? route.query['in'] : 'all'));
function setFilter(next: string) {
	const { in: _in, focus: _focus, ...rest } = route.query;
	void router.replace({ query: next === 'all' ? rest : { ...rest, in: next } });
}

function matches(item: AnswerItem): boolean {
	const f = filter.value;
	if (f === 'all') return true;
	if (f === 'team') return item.source === 'team';
	if (f === 'chat') return item.source === 'mention';
	return item.source === 'mail' && item.mailboxId === f;
}
const source = computed(() => queue.items.value.filter(matches));

function orderKey(item: AnswerItem): TaskFlowOrderKey {
	if (item.source === 'mail') {
		return {
			id: item.id,
			kind: mailAnswerKind(item.row),
			threadId: item.row.threadId,
			contactKey: item.row.fromAddress,
		};
	}
	if (item.source === 'team') {
		const hasDraft = !!item.entry.message.draftResponse?.trim();
		return {
			id: item.id,
			kind: hasDraft ? 'draft_review' : 'reply',
			threadId: item.entry.thread?._id,
			contactKey: item.entry.message.from,
		};
	}
	return { id: item.id, kind: 'reply', threadId: item.mention.roomId };
}

const flow = useTaskFlow<AnswerItem>(source, { key: orderKey });
const current = computed(() => flow.current.value);
const estimateLabel = computed(() => formatTaskFlowEstimate(flow.remainingSeconds.value));

function headline(item: AnswerItem): string {
	if (item.source === 'mail') {
		const h = replyQueueHeadline(item.row);
		return typeof h === 'string' ? t(h) : t(h.key, h.params ?? {});
	}
	if (item.source === 'team') return item.entry.message.subject;
	return `#${item.mention.roomName}: ${item.mention.messagePreview}`;
}
const peekLabel = computed(() => (flow.nextItem.value ? headline(flow.nextItem.value) : ''));

// Enter the flow once the merged queue has loaded; re-enter when the filter changes.
function startFlow() {
	flow.start();
	const focus = route.query['focus'];
	if (typeof focus !== 'string') return;
	for (
		let i = 0;
		i < flow.total.value && flow.currentId.value !== focus && flow.canGoNext.value;
		i++
	) {
		flow.next();
	}
}
watch(
	[queue.isLoading, () => source.value.length, filter],
	([loading, length], previous) => {
		const filterChanged = previous && previous[2] !== filter.value;
		if (filterChanged) flow.exit();
		if (flow.active.value || loading || length === 0) return;
		startFlow();
	},
	{ immediate: true }
);

function controlsFor(item: AnswerItem): AnswerCardControls {
	return {
		complete: (outcome, inverse) =>
			flow.complete(item.id, { outcome, ...(inverse ? { inverse } : {}) }),
		skip: () => flow.skip(item.id),
		undoSelf: () => void flow.undoById(item.id),
		back: () => flow.back(),
		next: () => flow.next(),
	};
}

onMounted(() => window.addEventListener('keydown', flow.onWindowKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', flow.onWindowKeydown));

// Finishing the queue is a natural "I've caught up": move Today's watermark.
const { run: markSeen } = useBackendOperation(api.today.state.markSeen, {
	label: () => t('dashboard.today.operations.markSeen'),
});
watch(
	() => flow.isComplete.value,
	(complete) => {
		if (complete) void markSeen({});
	}
);

const chips = computed(() => {
	const count = (pred: (i: AnswerItem) => boolean) => queue.items.value.filter(pred).length;
	const list: Array<{
		id: string;
		label: string;
		count: number;
		slot?: number | null;
		icon?: string;
	}> = [{ id: 'all', label: t('components.answer.filter.all'), count: queue.items.value.length }];
	for (const inbox of inboxes.value) {
		const n = count((i) => i.source === 'mail' && i.mailboxId === inbox.mailboxId);
		if (n > 0) list.push({ id: inbox.mailboxId, label: inbox.name, count: n, slot: inbox.slot });
	}
	const team = count((i) => i.source === 'team');
	if (team > 0)
		list.push({
			id: 'team',
			label: t('components.shell.teamInbox'),
			count: team,
			icon: 'lucide:bot',
		});
	const chat = count((i) => i.source === 'mention');
	if (chat > 0)
		list.push({
			id: 'chat',
			label: t('components.shell.chat.title'),
			count: chat,
			icon: 'lucide:message-circle',
		});
	return list;
});
</script>

<template>
	<div>
		<div
			v-if="chips.length > 2"
			class="mx-auto flex max-w-2xl flex-wrap items-center gap-1.5 px-4 pt-6 sm:px-6"
			role="toolbar"
			:aria-label="t('components.answer.filter.label')"
		>
			<button
				v-for="chip in chips"
				:key="chip.id"
				type="button"
				:aria-pressed="filter === chip.id"
				class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors"
				:class="
					filter === chip.id
						? 'bg-text-primary text-text-inverse'
						: 'bg-bg-elevated text-text-secondary shadow-(--shadow-1) hover:text-text-primary'
				"
				@click="setFilter(chip.id)"
			>
				<InboxChip
					v-if="chip.slot !== undefined"
					:name="chip.label"
					:slot="chip.slot ?? null"
					variant="plain"
					class="!text-inherit"
				/>
				<template v-else>
					<Icon v-if="chip.icon" :name="chip.icon" class="size-3" />
					{{ chip.label }}
				</template>
				<span class="tabular-nums opacity-70">{{ chip.count }}</span>
			</button>
		</div>

		<div
			v-if="queue.isLoading.value && !flow.active.value"
			class="mx-auto max-w-2xl space-y-3 px-6 py-10"
		>
			<UiSkeleton class="h-4 w-40" />
			<UiSkeleton class="h-40 w-full rounded-2xl" />
		</div>

		<div
			v-else-if="!flow.active.value && source.length === 0"
			class="mx-auto max-w-md px-6 py-16 text-center"
		>
			<UiIconBox
				icon="lucide:check-circle-2"
				size="xl"
				variant="success"
				rounded="full"
				class="mb-4"
			/>
			<h2 class="font-display text-xl text-text-primary">
				{{ t('components.answer.empty.title') }}
			</h2>
			<p class="mt-1.5 text-sm text-text-secondary">{{ t('components.answer.empty.body') }}</p>
			<UiButton variant="secondary" to="/dashboard" class="mt-6">{{
				t('components.answer.backToToday')
			}}</UiButton>
		</div>

		<AgentTaskFlow
			v-else
			:position="flow.position.value"
			:total="flow.total.value"
			:new-count="flow.newCount.value"
			:estimate-label="estimateLabel"
			:current-key="flow.currentId.value"
			:peek-label="peekLabel"
			:complete="flow.isComplete.value"
			:can-undo="flow.canUndo.value"
			browsable
			:can-go-back="flow.canGoBack.value"
			:can-go-next="flow.canGoNext.value"
			@exit="navigateTo('/dashboard')"
			@undo="flow.undo()"
			@back="flow.back()"
			@next="flow.next()"
		>
			<template v-if="current">
				<AnswerIdentityBand :item="current" />
				<AnswerMailCard
					v-if="current.source === 'mail'"
					:key="current.id"
					:row="current.row"
					:mailbox-id="current.mailboxId"
					:controls="controlsFor(current)"
				/>
				<AnswerTeamCard
					v-else-if="current.source === 'team'"
					:key="current.id"
					:entry="current.entry"
					:controls="controlsFor(current)"
				/>
				<AnswerMentionCard
					v-else
					:key="current.id"
					:mention="current.mention"
					:controls="controlsFor(current)"
				/>
			</template>

			<template #done>
				<div class="py-8 text-center">
					<UiIconBox
						icon="lucide:check-circle-2"
						size="xl"
						variant="success"
						rounded="full"
						class="mb-4"
					/>
					<h2 class="font-display text-xl text-text-primary">
						{{ t('components.answer.done.title') }}
					</h2>
					<p v-if="flow.summary.value" class="mt-1.5 text-sm text-text-secondary">
						{{ t('components.answer.done.summary', { summary: flow.summary.value }) }}
					</p>
					<p class="mt-1 text-xs text-text-tertiary">{{ t('components.answer.done.body') }}</p>
					<div class="mt-6 flex items-center justify-center gap-2">
						<UiButton to="/dashboard">{{ t('components.answer.backToToday') }}</UiButton>
						<UiButton variant="secondary" to="/dashboard/inboxes">{{
							t('components.today.openInboxes')
						}}</UiButton>
					</div>
				</div>
			</template>
		</AgentTaskFlow>
	</div>
</template>
