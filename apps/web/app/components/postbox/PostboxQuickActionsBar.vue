<script setup lang="ts">
/**
 * Bulk-actions toolbar that floats above the thread list when one or
 * more messages are selected. Hidden when nothing is selected.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	folderRole?: string;
}>();

const { t } = useI18n();

const mailboxIdRef = computed(() => props.mailboxId);
const bulk = usePostboxBulkActions(mailboxIdRef);
const { folders } = usePostboxFolders(mailboxIdRef);
const { labels, setOnMessage } = usePostboxLabels(mailboxIdRef);

const moveOpen = ref(false);
const labelOpen = ref(false);
const snoozeOpen = ref(false);

const snoozeMutation = useBackendOperation(api.mail.snooze.snooze, {
	label: () => t('components.postbox.postboxQuickActionsBar.operations.snooze'),
});

async function applyLabel(labelId: Id<'mailLabels'>) {
	for (const id of bulk.ids.value) {
		await setOnMessage(id, labelId, true);
	}
	labelOpen.value = false;
}

async function snoozeSelected(until: number) {
	for (const id of bulk.ids.value) {
		const result = await snoozeMutation.run({ messageId: id, until });
		if (result === undefined) return;
	}
	bulk.clear();
}

const unsnoozeMutation = useBackendOperation(api.mail.snooze.unsnooze, {
	label: () => t('components.postbox.postboxQuickActionsBar.operations.unsnooze'),
});

async function unsnoozeSelected() {
	for (const id of bulk.ids.value) {
		const result = await unsnoozeMutation.run({ messageId: id });
		if (result === undefined) return;
	}
	bulk.clear();
}

// Permanent delete is irreversible (frees the raw .eml + body blobs), so guard
// it behind a confirm. Only offered from Trash, where "Delete" already means
// "remove for good" rather than "move to Trash".
async function purgeSelected() {
	const n = bulk.count.value;
	if (n === 0) return;
	if (!window.confirm(t('components.postbox.postboxQuickActionsBar.purgeConfirm', { count: n }, n)))
		return;
	await bulk.purgeSelected();
}

// Exclude the current folder and the non-destination system roles: moving a
// received message into Sent/Drafts mis-frames it as a sent/draft item.
const movableFolders = computed(() =>
	folders.value.filter((f) => {
		if (f.role === 'sent' || f.role === 'drafts') return false;
		if (props.folderRole && f.role === props.folderRole) return false;
		return true;
	})
);
</script>

<template>
	<Transition
		enter-active-class="transition-all duration-(--motion-moderate)"
		enter-from-class="-translate-y-full opacity-0"
		enter-to-class="translate-y-0 opacity-100"
		leave-active-class="transition-all duration-(--motion-moderate-exit)"
		leave-from-class="translate-y-0 opacity-100"
		leave-to-class="-translate-y-full opacity-0"
	>
		<div
			v-if="bulk.count.value > 0"
			class="sticky top-0 z-10 bg-bg-elevated border-b border-border-subtle px-3 py-2 flex items-center gap-2 text-sm shadow-sm"
		>
			<span class="font-medium">{{
				t('components.postbox.postboxQuickActionsBar.selected', { count: bulk.count.value })
			}}</span>
			<span class="w-px h-4 bg-border-subtle mx-1" />
			<UiButton
				variant="ghost"
				size="sm"
				class="gap-1.5 px-2 py-1"
				:title="t('components.postbox.postboxQuickActionsBar.markReadTitle')"
				@click="bulk.markRead(true)"
			>
				<template #iconLeft>
					<Icon name="lucide:mail-open" class="w-4 h-4" />
				</template>
				{{ t('components.postbox.postboxQuickActionsBar.read') }}
			</UiButton>
			<UiButton
				variant="ghost"
				size="sm"
				class="gap-1.5 px-2 py-1"
				:title="t('components.postbox.postboxQuickActionsBar.markUnreadTitle')"
				@click="bulk.markRead(false)"
			>
				<template #iconLeft>
					<Icon name="lucide:mail" class="w-4 h-4" />
				</template>
				{{ t('components.postbox.postboxQuickActionsBar.unread') }}
			</UiButton>
			<UiButton
				variant="ghost"
				size="sm"
				class="gap-1.5 px-2 py-1"
				:title="t('components.postbox.postboxQuickActionsBar.starTitle')"
				@click="bulk.star(true)"
			>
				<template #iconLeft>
					<Icon name="lucide:star" class="w-4 h-4" />
				</template>
				{{ t('components.postbox.postboxQuickActionsBar.star') }}
			</UiButton>
			<span class="w-px h-4 bg-border-subtle mx-1" />
			<div class="relative">
				<UiButton
					variant="ghost"
					size="sm"
					class="gap-1.5 px-2 py-1"
					@click="
						moveOpen = !moveOpen;
						labelOpen = false;
					"
				>
					<template #iconLeft>
						<Icon name="lucide:folder-input" class="w-4 h-4" />
					</template>
					{{ t('components.postbox.postboxQuickActionsBar.move') }}
				</UiButton>
				<div
					v-if="moveOpen"
					class="absolute top-full mt-1 left-0 bg-bg-elevated border border-border-subtle rounded shadow-lg w-44 max-h-64 overflow-auto z-20"
				>
					<button
						v-for="folder in movableFolders"
						:key="folder._id"
						type="button"
						class="w-full text-left px-3 py-1.5 text-sm hover:bg-bg-surface capitalize"
						@click="
							bulk.moveSelected(folder._id);
							moveOpen = false;
						"
					>
						{{ folder.role ?? folder.name }}
					</button>
				</div>
			</div>
			<div class="relative">
				<UiButton
					variant="ghost"
					size="sm"
					class="gap-1.5 px-2 py-1"
					@click="
						labelOpen = !labelOpen;
						moveOpen = false;
					"
				>
					<template #iconLeft>
						<Icon name="lucide:tag" class="w-4 h-4" />
					</template>
					{{ t('components.postbox.postboxQuickActionsBar.label') }}
				</UiButton>
				<div
					v-if="labelOpen"
					class="absolute top-full mt-1 left-0 bg-bg-elevated border border-border-subtle rounded shadow-lg w-44 max-h-64 overflow-auto z-20"
				>
					<button
						v-for="label in labels"
						:key="label._id"
						type="button"
						class="w-full text-left px-3 py-1.5 text-sm hover:bg-bg-surface flex items-center gap-2"
						@click="applyLabel(label._id)"
					>
						<span
							class="w-2.5 h-2.5 rounded-full"
							:style="{ backgroundColor: label.color || '#6b7280' }"
						/>
						{{ label.name }}
					</button>
					<div v-if="labels.length === 0" class="px-3 py-2 text-xs text-text-tertiary">
						{{ t('components.postbox.postboxQuickActionsBar.noLabels') }}
					</div>
				</div>
			</div>
			<UiButton
				v-if="props.folderRole !== 'snoozed'"
				variant="ghost"
				size="sm"
				class="gap-1.5 px-2 py-1"
				:title="t('components.postbox.postboxQuickActionsBar.snoozeTitle')"
				@click="snoozeOpen = true"
			>
				<template #iconLeft>
					<Icon name="lucide:clock" class="w-4 h-4" />
				</template>
				{{ t('components.postbox.postboxQuickActionsBar.snooze') }}
			</UiButton>
			<UiButton
				v-else
				variant="ghost"
				size="sm"
				class="gap-1.5 px-2 py-1"
				:title="t('components.postbox.postboxQuickActionsBar.unsnoozeTitle')"
				@click="unsnoozeSelected()"
			>
				<template #iconLeft>
					<Icon name="lucide:alarm-clock-off" class="w-4 h-4" />
				</template>
				{{ t('components.postbox.postboxQuickActionsBar.unsnooze') }}
			</UiButton>
			<UiButton
				v-if="props.folderRole === 'spam'"
				variant="ghost"
				size="sm"
				class="gap-1.5 px-2 py-1"
				:title="t('components.postbox.postboxQuickActionsBar.notSpamTitle')"
				@click="bulk.notSpamSelected()"
			>
				<template #iconLeft>
					<Icon name="lucide:shield-check" class="w-4 h-4" />
				</template>
				{{ t('components.postbox.postboxQuickActionsBar.notSpam') }}
			</UiButton>
			<UiButton
				v-else
				variant="ghost"
				size="sm"
				class="gap-1.5 px-2 py-1"
				:title="t('components.postbox.postboxQuickActionsBar.spamTitle')"
				@click="bulk.reportSpamSelected()"
			>
				<template #iconLeft>
					<Icon name="lucide:shield-alert" class="w-4 h-4" />
				</template>
				{{ t('components.postbox.postboxQuickActionsBar.spam') }}
			</UiButton>
			<span class="flex-1" />
			<UiButton
				variant="ghost"
				size="sm"
				class="gap-1.5 px-2 py-1"
				:title="t('components.postbox.postboxQuickActionsBar.archiveTitle')"
				@click="bulk.archiveSelected()"
			>
				<template #iconLeft>
					<Icon name="lucide:archive" class="w-4 h-4" />
				</template>
				{{ t('components.postbox.postboxQuickActionsBar.archive') }}
			</UiButton>
			<UiButton
				v-if="props.folderRole === 'trash'"
				variant="danger-ghost"
				size="sm"
				class="gap-1.5 px-2 py-1"
				:title="t('components.postbox.postboxQuickActionsBar.deleteForeverTitle')"
				@click="purgeSelected()"
			>
				<template #iconLeft>
					<Icon name="lucide:trash-2" class="w-4 h-4" />
				</template>
				{{ t('components.postbox.postboxQuickActionsBar.deleteForever') }}
			</UiButton>
			<UiButton
				v-else
				variant="danger-ghost"
				size="sm"
				class="gap-1.5 px-2 py-1"
				:title="t('components.postbox.postboxQuickActionsBar.deleteTitle')"
				@click="bulk.trashSelected()"
			>
				<template #iconLeft>
					<Icon name="lucide:trash" class="w-4 h-4" />
				</template>
				{{ t('common.delete') }}
			</UiButton>
			<span class="w-px h-4 bg-border-subtle mx-1" />
			<button
				type="button"
				class="p-1 rounded hover:bg-bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				:title="t('components.postbox.postboxQuickActionsBar.clearSelectionTitle')"
				@click="bulk.clear()"
			>
				<Icon name="lucide:x" class="w-4 h-4" />
			</button>
		</div>
	</Transition>
	<PostboxSnoozeDialog
		:open="snoozeOpen"
		@update:open="snoozeOpen = $event"
		@confirm="snoozeSelected"
	/>
</template>
