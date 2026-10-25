<script setup lang="ts">
/**
 * The Team Inbox list's bulk bar: how many conversations are selected and the
 * verbs that act on all of them (assign, resolve, snooze), with the keys that
 * do the same from the list. Shown only while something is selected.
 *
 * Pure presentation: the list owns the selection and every mutation, and the
 * same handlers serve the keyboard, the row menus and this bar.
 */
import type { AssignPopoverMember } from '~/components/inbox/AssignPopover.vue';
import { useShortcutLabels } from '~/composables/useShortcutLabels';

const props = defineProps<{
	count: number;
	members: AssignPopoverMember[];
	currentUserId: string | null;
	/** The assignee picker; the list opens it on `a` while rows are selected. */
	assignOpen: boolean;
}>();

const emit = defineEmits<{
	assign: [assignedTo: string | undefined];
	resolve: [];
	snooze: [];
	clear: [];
	'update:assignOpen': [value: boolean];
}>();

const { t } = useI18n();
const { titleWithShortcut } = useShortcutLabels();

const assignOpenModel = computed({
	get: () => props.assignOpen,
	set: (value: boolean) => emit('update:assignOpen', value),
});
</script>

<template>
	<div
		class="sticky top-0 z-10 mb-2 flex flex-wrap items-center gap-x-1 gap-y-1 rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2 text-sm shadow-sm"
		role="toolbar"
		:aria-label="t('components.inbox.bulkBar.label')"
		data-testid="inbox-bulk-bar"
	>
		<span class="whitespace-nowrap font-medium tabular-nums" aria-live="polite">
			{{ t('components.inbox.bulkBar.selected', { count }, count) }}
		</span>
		<span class="mx-1 h-4 w-px bg-border-subtle" aria-hidden="true" />
		<InboxAssignPopover
			v-model:open="assignOpenModel"
			:members="members"
			:current-user-id="currentUserId"
			position="left"
			assign-shortcut-id="inboxList.assignToMe"
			@assign="emit('assign', $event)"
		>
			<template #trigger>
				<UiButton
					variant="ghost"
					size="sm"
					class="gap-1.5 px-2 py-1"
					:title="titleWithShortcut(t('components.inbox.bulkBar.assign'), 'inboxList.assign')"
				>
					<template #iconLeft>
						<Icon name="lucide:user-plus" class="h-4 w-4" />
					</template>
					{{ t('components.inbox.bulkBar.assign') }}
				</UiButton>
			</template>
		</InboxAssignPopover>
		<UiButton
			variant="ghost"
			size="sm"
			class="gap-1.5 px-2 py-1"
			:title="titleWithShortcut(t('components.inbox.inboxThreadRow.resolve'), 'inboxList.resolve')"
			data-testid="inbox-bulk-resolve"
			@click="emit('resolve')"
		>
			<template #iconLeft>
				<Icon name="lucide:check-circle" class="h-4 w-4" />
			</template>
			{{ t('components.inbox.inboxThreadRow.resolve') }}
		</UiButton>
		<UiButton
			variant="ghost"
			size="sm"
			class="gap-1.5 px-2 py-1"
			:title="titleWithShortcut(t('components.inbox.inboxThreadRow.snooze'), 'inboxList.snooze')"
			data-testid="inbox-bulk-snooze"
			@click="emit('snooze')"
		>
			<template #iconLeft>
				<Icon name="lucide:clock" class="h-4 w-4" />
			</template>
			{{ t('components.inbox.inboxThreadRow.snooze') }}
		</UiButton>
		<span class="min-w-0 flex-1" />
		<UiButton
			variant="ghost"
			size="sm"
			class="px-2 py-1"
			:title="titleWithShortcut(t('components.inbox.bulkBar.clear'), 'inboxList.clearSelection')"
			:aria-label="t('components.inbox.bulkBar.clear')"
			data-testid="inbox-bulk-clear"
			@click="emit('clear')"
		>
			<Icon name="lucide:x" class="h-4 w-4" />
		</UiButton>
	</div>
</template>
