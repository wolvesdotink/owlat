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

const mailboxIdRef = computed(() => props.mailboxId);
const bulk = usePostboxBulkActions(mailboxIdRef);
const { folders } = usePostboxFolders(mailboxIdRef);
const { labels, setOnMessage } = usePostboxLabels(mailboxIdRef);

const moveOpen = ref(false);
const labelOpen = ref(false);
const snoozeOpen = ref(false);

const snoozeMutation = useBackendOperation(api.mail.snooze.snooze, {
	label: 'Snooze messages',
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
	label: 'Un-snooze messages',
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
	if (
		!window.confirm(
			`Permanently delete ${n} message${n === 1 ? '' : 's'}? This cannot be undone.`,
		)
	)
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
	}),
);
</script>

<template>
	<Transition
		enter-active-class="transition-all duration-150"
		enter-from-class="-translate-y-full opacity-0"
		enter-to-class="translate-y-0 opacity-100"
		leave-active-class="transition-all duration-100"
		leave-from-class="translate-y-0 opacity-100"
		leave-to-class="-translate-y-full opacity-0"
	>
		<div
			v-if="bulk.count.value > 0"
			class="sticky top-0 z-10 bg-bg-elevated border-b border-border-subtle px-3 py-2 flex items-center gap-2 text-sm shadow-sm"
		>
			<span class="font-medium">{{ bulk.count.value }} selected</span>
			<span class="w-px h-4 bg-border-subtle mx-1" />
			<button
				type="button"
				class="px-2 py-1 rounded hover:bg-bg-surface flex items-center gap-1.5"
				title="Mark as read"
				@click="bulk.markRead(true)"
			>
				<Icon name="lucide:mail-open" class="w-4 h-4" />
				Read
			</button>
			<button
				type="button"
				class="px-2 py-1 rounded hover:bg-bg-surface flex items-center gap-1.5"
				title="Mark as unread"
				@click="bulk.markRead(false)"
			>
				<Icon name="lucide:mail" class="w-4 h-4" />
				Unread
			</button>
			<button
				type="button"
				class="px-2 py-1 rounded hover:bg-bg-surface flex items-center gap-1.5"
				title="Star"
				@click="bulk.star(true)"
			>
				<Icon name="lucide:star" class="w-4 h-4" />
				Star
			</button>
			<span class="w-px h-4 bg-border-subtle mx-1" />
			<div class="relative">
				<button
					type="button"
					class="px-2 py-1 rounded hover:bg-bg-surface flex items-center gap-1.5"
					@click="moveOpen = !moveOpen; labelOpen = false"
				>
					<Icon name="lucide:folder-input" class="w-4 h-4" />
					Move
				</button>
				<div
					v-if="moveOpen"
					class="absolute top-full mt-1 left-0 bg-bg-elevated border border-border-subtle rounded shadow-lg w-44 max-h-64 overflow-auto z-20"
				>
					<button
						v-for="folder in movableFolders"
						:key="folder._id"
						type="button"
						class="w-full text-left px-3 py-1.5 text-sm hover:bg-bg-surface capitalize"
						@click="bulk.moveSelected(folder._id); moveOpen = false"
					>
						{{ folder.role ?? folder.name }}
					</button>
				</div>
			</div>
			<div class="relative">
				<button
					type="button"
					class="px-2 py-1 rounded hover:bg-bg-surface flex items-center gap-1.5"
					@click="labelOpen = !labelOpen; moveOpen = false"
				>
					<Icon name="lucide:tag" class="w-4 h-4" />
					Label
				</button>
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
					<div
						v-if="labels.length === 0"
						class="px-3 py-2 text-xs text-text-tertiary"
					>No labels yet</div>
				</div>
			</div>
			<button
				v-if="props.folderRole !== 'snoozed'"
				type="button"
				class="px-2 py-1 rounded hover:bg-bg-surface flex items-center gap-1.5"
				title="Snooze"
				@click="snoozeOpen = true"
			>
				<Icon name="lucide:clock" class="w-4 h-4" />
				Snooze
			</button>
			<button
				v-else
				type="button"
				class="px-2 py-1 rounded hover:bg-bg-surface flex items-center gap-1.5"
				title="Un-snooze — return to its folder now"
				@click="unsnoozeSelected()"
			>
				<Icon name="lucide:alarm-clock-off" class="w-4 h-4" />
				Un-snooze
			</button>
			<button
					v-if="props.folderRole === 'spam'"
					type="button"
					class="px-2 py-1 rounded hover:bg-bg-surface flex items-center gap-1.5"
					title="Not spam — move to Inbox"
					@click="bulk.notSpamSelected()"
				>
					<Icon name="lucide:shield-check" class="w-4 h-4" />
					Not spam
				</button>
				<button
					v-else
					type="button"
					class="px-2 py-1 rounded hover:bg-bg-surface flex items-center gap-1.5"
					title="Report spam"
					@click="bulk.reportSpamSelected()"
				>
					<Icon name="lucide:shield-alert" class="w-4 h-4" />
					Spam
				</button>
				<span class="flex-1" />
			<button
				type="button"
				class="px-2 py-1 rounded hover:bg-bg-surface flex items-center gap-1.5"
				title="Archive"
				@click="bulk.archiveSelected()"
			>
				<Icon name="lucide:archive" class="w-4 h-4" />
				Archive
			</button>
			<button
				v-if="props.folderRole === 'trash'"
				type="button"
				class="px-2 py-1 rounded hover:bg-error/10 text-error flex items-center gap-1.5"
				title="Permanently delete — frees storage and cannot be undone"
				@click="purgeSelected()"
			>
				<Icon name="lucide:trash-2" class="w-4 h-4" />
				Delete forever
			</button>
			<button
				v-else
				type="button"
				class="px-2 py-1 rounded hover:bg-error/10 text-error flex items-center gap-1.5"
				title="Move to Trash"
				@click="bulk.trashSelected()"
			>
				<Icon name="lucide:trash" class="w-4 h-4" />
				Delete
			</button>
			<span class="w-px h-4 bg-border-subtle mx-1" />
			<button
				type="button"
				class="p-1 rounded hover:bg-bg-surface"
				title="Clear selection"
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
