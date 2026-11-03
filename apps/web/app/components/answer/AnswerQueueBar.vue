<script setup lang="ts">
import { useAnswerQueueSession } from '~/composables/useAnswerQueueSession';
import { useAnswerQueueChips } from '~/composables/useAnswerQueueChips';
import { useAnswerMailActions } from '~/composables/useAnswerMailActions';
import { useAnswerLayout } from '~/composables/useAnswerSheet';
import { useKeyboardShortcuts } from '~/composables/useKeyboardShortcuts';
import { useShortcutLabels } from '~/composables/useShortcutLabels';
import { isDialogOpen } from '~/utils/dialogOpen';
import {
	ArchiveIcon,
	CheckIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ClockIcon,
	InboxIcon,
	ListChecklistIcon,
} from '@coolicons/vue';

/**
 * The Answer queue in Answer mode's top bar (the frame's `#queue` slot):
 * "1 of 3 ‹ ›", and a menu with the queue's filter and the verbs that finish
 * an item without a reply. Renders nothing when the page is not part of a
 * queue.
 *
 * Keys (the `answer` scope, so a remap moves them), whenever no text field,
 * dialog or chord has them: `[` / `]` previous / next item, `e` archive and
 * `h` snooze (Postbox items). Browsing finishes
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

// A phone's top bar is one line: the menu keeps its icon, and the subject the room.
const layout = useAnswerLayout();

// Each key is claimed only while its verb can run; otherwise the press is
// left alone, like a disabled button.
const { registerShortcut } = useKeyboardShortcuts();
const live = (can: () => boolean) => () => visible.value && !isDialogOpen() && can();
registerShortcut({
	id: 'answer.previousItem',
	handler: () => session?.back(),
	when: live(() => !!session?.flow.canGoBack.value),
});
registerShortcut({
	id: 'answer.nextItem',
	handler: () => session?.next(),
	when: live(() => !!session?.flow.canGoNext.value),
});
registerShortcut({ id: 'answer.archive', handler: archive, when: live(() => canArchive.value) });
registerShortcut({ id: 'answer.snooze', handler: openSnooze, when: live(() => canSnooze.value) });
const { labelFor } = useShortcutLabels();

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
			<UiTooltip :text="t('components.answer.queueBar.previous')">
				<UiButton
					variant="ghost"
					size="sm"
					:disabled="!session.flow.canGoBack.value"
					:aria-label="t('components.answer.queueBar.previous')"
					data-testid="answer-queue-previous"
					@click="session.back()"
				>
					<ChevronLeftIcon class="size-4" />
				</UiButton>
			</UiTooltip>
			<span class="tabular-nums" data-testid="answer-queue-position">
				{{
					t('components.answer.queueBar.position', {
						position: session.flow.position.value,
						total: session.flow.total.value,
					})
				}}
			</span>
			<UiTooltip :text="t('components.answer.queueBar.next')">
				<UiButton
					variant="ghost"
					size="sm"
					:disabled="!session.flow.canGoNext.value"
					:aria-label="t('components.answer.queueBar.next')"
					data-testid="answer-queue-next"
					@click="session.next()"
				>
					<ChevronRightIcon class="size-4" />
				</UiButton>
			</UiTooltip>
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
			:trigger-text="layout === 'phone' ? undefined : t('components.answer.queueBar.inQueue')"
			:icon="ListChecklistIcon"
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
						<ArchiveIcon class="size-4 text-text-tertiary" />
						<span class="flex-1">{{ t('common.archive') }}</span>
						<kbd v-if="labelFor('answer.archive')" class="font-mono text-2xs text-text-tertiary">{{
							labelFor('answer.archive')
						}}</kbd>
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
						<ClockIcon class="size-4 text-text-tertiary" />
						<span class="flex-1">{{ t('components.postbox.postboxReplyFlow.snooze') }}</span>
						<kbd v-if="labelFor('answer.snooze')" class="font-mono text-2xs text-text-tertiary">{{
							labelFor('answer.snooze')
						}}</kbd>
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
						<CheckIcon class="size-4 text-text-tertiary" />
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
					<component
						:is="session.filter.value === chip.id ? CheckIcon : chip.icon || InboxIcon"
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
