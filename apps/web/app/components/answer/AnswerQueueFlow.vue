<script setup lang="ts">
import AgentTaskFlow from '~/components/agent-tasks/AgentTaskFlow.vue';
import type { AnswerItem } from '~/composables/useAnswerQueue';
import {
	createAnswerQueueSession,
	useAnswerQueueSession,
} from '~/composables/useAnswerQueueSession';
import { formatTaskFlowEstimate } from '~/utils/taskFlow';
import { replyQueueHeadline } from '~/utils/postboxReplyQueue';
import { opensInAnswerMode } from '~/utils/answerQueue';
import { useAnswerQueueChips } from '~/composables/useAnswerQueueChips';

/**
 * The Answer queue page's body — over everything waiting on the viewer's
 * answer: mail from every inbox they read, the team inbox's agent drafts, chat
 * mentions. Filter chips narrow it to one inbox (`?in=<mailboxId>`), the team
 * inbox (`?in=team`) or chat (`?in=chat`); `?focus=<id>` opens on a given item.
 *
 * The queue itself is the session the parent route owns
 * (useAnswerQueueSession): its current item opens in Answer mode when it has
 * one, so this page shows the loading, empty and done states, and the items
 * that stay cards (chat mentions, follow-up reminders).
 */
const { t } = useI18n();
const session = useAnswerQueueSession() ?? createAnswerQueueSession();
const { queue, flow, filter, source } = session;

const setFilter = (next: string) => session.setFilter(next);
const current = computed(() => flow.current.value);
const estimateLabel = computed(() => formatTaskFlowEstimate(flow.remainingSeconds.value));
// The current item is on its way to Answer mode: hold the skeleton rather than
// flashing its card for a frame.
const leavingForAnswerMode = computed(
	() => !!current.value && !flow.isComplete.value && opensInAnswerMode(current.value)
);

function headline(item: AnswerItem): string {
	if (item.source === 'mail') {
		const h = replyQueueHeadline(item.row);
		return typeof h === 'string' ? t(h) : t(h.key, h.params ?? {});
	}
	if (item.source === 'team') return item.entry.message.subject;
	return `#${item.mention.roomName}: ${item.mention.messagePreview}`;
}
const peekLabel = computed(() => (flow.nextItem.value ? headline(flow.nextItem.value) : ''));

const { chips, showChips, activeChipLabel } = useAnswerQueueChips(session);
</script>

<template>
	<div>
		<div
			v-if="showChips"
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
			v-if="(queue.isLoading.value && !flow.active.value) || leavingForAnswerMode"
			class="mx-auto max-w-2xl space-y-3 px-6 py-10"
		>
			<UiSkeleton class="h-4 w-40" />
			<UiSkeleton class="h-40 w-full rounded-2xl" />
		</div>

		<!-- Nothing to show because a read failed is not "all clear" (#721). -->
		<UiQueryBoundary
			v-else-if="queue.error.value && !flow.active.value && source.length === 0"
			:error="queue.error.value"
			@retry="queue.refetch"
		/>

		<!-- Nothing waiting is good news: the "all clear" tone, not "nothing yet". -->
		<UiEmptyState
			v-else-if="!flow.active.value && source.length === 0"
			class="mx-auto max-w-md"
			tone="clear"
			:title="
				activeChipLabel
					? t('components.answer.empty.titleIn', { inbox: activeChipLabel })
					: t('components.answer.empty.title')
			"
			:description="t('components.answer.empty.body')"
		>
			<template #action>
				<div class="flex items-center justify-center gap-2">
					<UiButton v-if="activeChipLabel" variant="secondary" @click="setFilter('all')">
						{{ t('components.answer.empty.showAll') }}
					</UiButton>
					<UiButton variant="secondary" to="/dashboard">{{
						t('components.answer.backToToday')
					}}</UiButton>
				</div>
			</template>
		</UiEmptyState>

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
			@undo="session.undo()"
			@back="session.back()"
			@next="session.next()"
		>
			<template v-if="current">
				<AnswerIdentityBand :item="current" />
				<AnswerMailCard
					v-if="current.source === 'mail'"
					:key="current.id"
					:row="current.row"
					:mailbox-id="current.mailboxId"
					:controls="session.controlsFor(current)"
				/>
				<AnswerTeamCard
					v-else-if="current.source === 'team'"
					:key="current.id"
					:entry="current.entry"
					:controls="session.controlsFor(current)"
				/>
				<AnswerMentionCard
					v-else
					:key="current.id"
					:mention="current.mention"
					:controls="session.controlsFor(current)"
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
