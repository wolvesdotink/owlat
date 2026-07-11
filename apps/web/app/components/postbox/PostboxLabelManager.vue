<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	open: boolean;
}>();

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
}>();

const mailboxIdRef = computed(() => props.mailboxId);
const { labels, create, rename, setColor, remove } = usePostboxLabels(mailboxIdRef);

const newName = ref('');
const newColor = ref(DEFAULT_LABEL_COLOR);
const editingId = ref<Id<'mailLabels'> | null>(null);
const editingName = ref('');

const PRESET_COLORS = LABEL_PRESET_HEXES;

async function handleCreate() {
	const trimmed = newName.value.trim();
	if (!trimmed) return;
	await create(trimmed, newColor.value);
	newName.value = '';
}

function startEdit(labelId: Id<'mailLabels'>, currentName: string) {
	editingId.value = labelId;
	editingName.value = currentName;
}

async function commitRename() {
	if (!editingId.value) return;
	await rename(editingId.value, editingName.value);
	editingId.value = null;
}

function close() {
	emit('update:open', false);
}
</script>

<template>
	<UiModal
		:open="open"
		title="Manage labels"
		size="md"
		@update:open="
			(v) => {
				if (!v) close();
			}
		"
	>
		<form class="flex items-center gap-2 mb-4" @submit.prevent="handleCreate">
			<div class="flex items-center gap-1">
				<button
					v-for="color in PRESET_COLORS"
					:key="color"
					type="button"
					class="w-5 h-5 rounded-full border-2"
					:class="newColor === color ? 'border-text-primary' : 'border-transparent'"
					:style="{ backgroundColor: color }"
					:title="color"
					@click="newColor = color"
				/>
			</div>
			<input v-model="newName" type="text" placeholder="New label name" class="input flex-1" />
			<button type="submit" class="btn btn-primary" :disabled="!newName.trim()">Add</button>
		</form>

		<ul v-if="labels.length > 0" class="space-y-2 max-h-80 overflow-auto">
			<li
				v-for="label in labels"
				:key="label._id"
				class="flex items-center gap-2 px-3 py-2 rounded border border-border-subtle"
			>
				<span
					class="w-3 h-3 rounded-full flex-shrink-0"
					:style="{ backgroundColor: label.color || 'var(--color-text-tertiary)' }"
				/>
				<input
					v-if="editingId === label._id"
					v-model="editingName"
					type="text"
					class="flex-1 bg-transparent outline-none"
					@blur="commitRename"
					@keyup.enter="commitRename"
					@keyup.escape="editingId = null"
				/>
				<span v-else class="flex-1 cursor-text" @click="startEdit(label._id, label.name)">{{
					label.name
				}}</span>
				<div class="flex items-center gap-1">
					<button
						v-for="color in PRESET_COLORS"
						:key="color"
						type="button"
						class="w-3.5 h-3.5 rounded-full border"
						:class="label.color === color ? 'border-text-primary' : 'border-transparent'"
						:style="{ backgroundColor: color }"
						:title="`Set color ${color}`"
						@click="setColor(label._id, color)"
					/>
				</div>
				<button
					type="button"
					class="p-1 rounded hover:bg-error/10 text-error"
					title="Delete label"
					@click="remove(label._id)"
				>
					<Icon name="lucide:trash" class="w-4 h-4" />
				</button>
			</li>
		</ul>
		<div v-else class="text-sm text-text-secondary py-6 text-center">
			No labels yet. Create one above.
		</div>
	</UiModal>
</template>
