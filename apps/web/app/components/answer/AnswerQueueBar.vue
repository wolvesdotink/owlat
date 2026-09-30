<script setup lang="ts">
import { useAnswerQueueSession } from '~/composables/useAnswerQueueSession';
import { useAnswerQueueChips } from '~/composables/useAnswerQueueChips';
import { useAnswerMailActions } from '~/composables/useAnswerMailActions';
import { isDialogOpen } from '~/utils/dialogOpen';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import { isChordPending } from '~/utils/shortcutScope';

/**
 * The Answer queue in Answer mode's top bar (the frame's `#queue` slot):
 * "1 of 3 ‹ ›", and a menu with the queue's filter and the verbs that finish
 * an item without a reply. Renders nothing when the page is not part of a
 * queue.
 *
 * Keys, whenever no text field, dialog or chord has them: `[` / `]` previous /
 * next item, `e` archive and `h` snooze (Postbox items). Browsing finishes
 * nothing; archive, snooze and Done do, and move on to the next item.
 *
 * A team item has no snooze here: snoozing its thread does not take the
 * message off the review queue (it stays `draft_ready`), so the item came
 * straight back on the next pass. Until the review queue honours a snoozed
 * thread, a team item is answered, rejected or left.
 */
const { t } = useI18n();
const session = useAnswerQueueSession();

const item = computed(() => session?.flow.current.value ?? null);
const visible = computed(
	() =>
		!!session &&
		session.engaged.value &&
		session.flow.active.value &&
		!session.flow.isComplete.value
);
const isCurrent = computed(() => visible.value && !!session?.isCurrentRoute.value);

const mailRow = computed(() => (item.value?.source === 'mail' ? item.value.row : null));

const mail = useAnswerMailActions(
	() => (isCurrent.value ? mailRow.value : null),
	() => session
);

const busy = ref(false);
async function run(action: () => Promise<unknown>) {
	if (busy.value) return;
	busy.value = true;
	try {
		await action();
	} finally {
		busy.value = false;
	}
}

const canArchive = computed(() => isCurrent.value && mailRow.value !== null);
const canSnooze = computed(() => isCurrent.value && mailRow.value !== null);
const canMarkDone = computed(() => isCurrent.value && mailRow.value !== null);

function archive() {
	if (canArchive.value) void run(() => mail.archive());
}
function markDone() {
	if (canMarkDone.value) void run(() => mail.markDone());
}

const snoozeOpen = ref(false);
function openSnooze() {
	if (canSnooze.value) snoozeOpen.value = true;
}
function confirmSnooze(until: number) {
	snoozeOpen.value = false;
	void run(async () => {
		if (mailRow.value) await mail.snooze(until);
	});
}

const { chips } = useAnswerQueueChips(session);

function onKeydown(event: KeyboardEvent) {
	if (!visible.value || !session) return;
	if (event.defaultPrevented || event.isComposing) return;
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target) || isDialogOpen() || isChordPending()) return;
	const key = event.key;
	if (key === '[' && session.flow.canGoBack.value) session.back();
	else if (key === ']' && session.flow.canGoNext.value) session.next();
	else if ((key === 'e' || key === 'E') && canArchive.value) archive();
	else if ((key === 'h' || key === 'H') && canSnooze.value) openSnooze();
	else return;
	event.preventDefault();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const menuItem =
	'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-bg-surface disabled:opacity-50';
</script>

<template>
	<div
		v-if="visible && session"
		class="flex shrink-0 items-center gap-1 text-xs text-text-secondary"
		data-testid="answer-queue-bar"
	>
		<template v-if="isCurrent">
			<UiButton
				variant="ghost"
				size="sm"
				:disabled="!session.flow.canGoBack.value"
				:aria-label="t('components.answer.queueBar.previous')"
				:title="t('components.answer.queueBar.previous')"
				data-testid="answer-queue-previous"
				@click="session.back()"
			>
				<Icon name="lucide:chevron-left" class="size-4" />
			</UiButton>
			<span class="tabular-nums" data-testid="answer-queue-position">
				{{
					t('components.answer.queueBar.position', {
						position: session.flow.position.value,
						total: session.flow.total.value,
					})
				}}
			</span>
			<UiButton
				variant="ghost"
				size="sm"
				:disabled="!session.flow.canGoNext.value"
				:aria-label="t('components.answer.queueBar.next')"
				:title="t('components.answer.queueBar.next')"
				data-testid="answer-queue-next"
				@click="session.next()"
			>
				<Icon name="lucide:chevron-right" class="size-4" />
			</UiButton>
		</template>
		<UiButton
			v-else
			variant="ghost"
			size="sm"
			data-testid="answer-queue-return"
			@click="session.goCurrent()"
		>
			{{ t('components.answer.queueBar.backToQueue') }}
		</UiButton>

		<PostboxOverflowMenu
			:label="t('components.answer.queueBar.menu')"
			:trigger-text="t('components.answer.queueBar.inQueue')"
			icon="lucide:list-checks"
			align="right"
		>
			<template #default="{ close }">
				<template v-if="isCurrent">
					<button
						v-if="canArchive"
						type="button"
						role="menuitem"
						:class="menuItem"
						:disabled="busy"
						data-testid="answer-queue-archive"
						@click="(close(), archive())"
					>
						<Icon name="lucide:archive" class="size-4 text-text-tertiary" />
						<span class="flex-1">{{ t('common.archive') }}</span>
						<kbd class="font-mono text-2xs text-text-tertiary">E</kbd>
					</button>
					<button
						v-if="canSnooze"
						type="button"
						role="menuitem"
						:class="menuItem"
						:disabled="busy"
						data-testid="answer-queue-snooze"
						@click="(close(), openSnooze())"
					>
						<Icon name="lucide:clock" class="size-4 text-text-tertiary" />
						<span class="flex-1">{{ t('components.postbox.postboxReplyFlow.snooze') }}</span>
						<kbd class="font-mono text-2xs text-text-tertiary">H</kbd>
					</button>
					<button
						v-if="canMarkDone"
						type="button"
						role="menuitem"
						:class="menuItem"
						:disabled="busy"
						data-testid="answer-queue-done"
						@click="(close(), markDone())"
					>
						<Icon name="lucide:check" class="size-4 text-text-tertiary" />
						<span class="flex-1">{{ t('components.answer.queueBar.markDone') }}</span>
					</button>
					<div class="my-1 border-t border-border-subtle" role="separator" />
				</template>
				<p class="px-3 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wide text-text-tertiary">
					{{ t('components.answer.filter.label') }}
				</p>
				<button
					v-for="chip in chips"
					:key="chip.id"
					type="button"
					role="menuitemradio"
					:aria-checked="session.filter.value === chip.id"
					:class="menuItem"
					data-testid="answer-queue-filter"
					@click="(close(), session.setFilter(chip.id))"
				>
					<Icon
						:name="session.filter.value === chip.id ? 'lucide:check' : chip.icon || 'lucide:inbox'"
						class="size-4 text-text-tertiary"
					/>
					<span class="flex-1 truncate">{{ chip.label }}</span>
					<span class="tabular-nums text-text-tertiary">{{ chip.count }}</span>
				</button>
			</template>
		</PostboxOverflowMenu>

		<PostboxSnoozeDialog
			:open="snoozeOpen"
			@update:open="snoozeOpen = $event"
			@confirm="confirmSnooze"
		/>
	</div>
</template>
