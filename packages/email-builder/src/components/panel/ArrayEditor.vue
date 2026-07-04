<script setup lang="ts">
import { computed } from 'vue';
import type { PropertyField } from '../../schema/types';
import { createArrayItem } from '../../schema/arrayItem';
import { GripVertical, Plus, Trash2 } from '@lucide/vue';
import { VueDraggable } from 'vue-draggable-plus';
import IconButton from '../ui/IconButton.vue';
import ActionButton from '../ui/ActionButton.vue';
import FieldLabel from '../ui/FieldLabel.vue';

const props = defineProps<{
	field: PropertyField;
	value: unknown[];
}>();

const emit = defineEmits<{
	(e: 'update', value: unknown[]): void;
}>();

const items = computed(() => {
	if (!Array.isArray(props.value)) return [];
	return props.value;
});

// Primitive string array (string[]): render one text input per item.
const isStringArray = computed(() => {
	if (props.field.itemType === 'string') return true;
	if (props.field.itemType === 'string[]') return false;
	return items.value.length > 0 && typeof items.value[0] === 'string';
});

// Matrix (string[][]): render a row of text inputs, one per cell.
const isMatrix = computed(() => props.field.itemType === 'string[]');

function addItem() {
	emit('update', [...items.value, createArrayItem(props.field, items.value)]);
}

function removeItem(index: number) {
	const updated = [...items.value];
	updated.splice(index, 1);
	emit('update', updated);
}

function updateItem(index: number, value: unknown) {
	const updated = [...items.value];
	updated[index] = value;
	emit('update', updated);
}

function updateCell(rowIndex: number, cellIndex: number, value: string) {
	const updated = [...items.value];
	const current = updated[rowIndex];
	const row = Array.isArray(current) ? [...current] : [];
	row[cellIndex] = value;
	updated[rowIndex] = row;
	emit('update', updated);
}

function updateItemField(index: number, key: string, value: unknown) {
	const updated = [...items.value];
	updated[index] = { ...(updated[index] as Record<string, unknown>), [key]: value };
	emit('update', updated);
}

function handleReorder(newItems: unknown[]) {
	emit('update', [...newItems]);
}
</script>

<template>
	<div class="flex flex-col gap-1">
		<VueDraggable
			:model-value="items"
			handle=".array-editor-drag-handle"
			:animation="150"
			class="flex flex-col gap-1"
			@update:model-value="handleReorder"
		>
			<div v-for="(item, index) in items" :key="index" class="group/item flex items-start gap-1 p-1.5 border border-border-subtle rounded-lg bg-bg-surface transition-[border-color] duration-(--motion-fast) hover:border-border-strong">
				<div class="array-editor-drag-handle flex items-center py-1 cursor-grab text-text-tertiary opacity-0 group-hover/item:opacity-100 transition-opacity duration-(--motion-fast) active:cursor-grabbing">
					<GripVertical :size="12" />
				</div>

				<div class="flex-1 flex flex-col gap-1 min-w-0">
					<!-- String array: simple text input -->
					<template v-if="isStringArray">
						<input
							type="text"
							class="w-full py-1 px-1.5 text-xs border border-border-subtle rounded bg-bg-surface text-text-primary outline-none transition-[border-color] duration-(--motion-fast) focus:border-brand"
							:value="item as string"
							@input="(e) => updateItem(index, (e.target as HTMLInputElement).value)"
						/>
					</template>

					<!-- Matrix (string[][]): one text input per cell -->
					<template v-else-if="isMatrix">
						<div class="flex flex-wrap gap-1">
							<input
								v-for="(cell, cellIndex) in (item as string[])"
								:key="cellIndex"
								type="text"
								class="min-w-0 flex-1 py-1 px-1.5 text-xs border border-border-subtle rounded bg-bg-surface text-text-primary outline-none transition-[border-color] duration-(--motion-fast) focus:border-brand"
								:value="cell"
								@input="(e) => updateCell(index, cellIndex, (e.target as HTMLInputElement).value)"
							/>
						</div>
					</template>

					<!-- Object array: render sub-fields -->
					<template v-else-if="field.itemSchema">
						<div
							v-for="subField in field.itemSchema"
							:key="subField.key"
							class="flex flex-col gap-0.5"
						>
							<FieldLabel size="sm">{{ subField.label }}</FieldLabel>
							<!-- Simple text/url sub-fields -->
							<input
								v-if="subField.type === 'text' || subField.type === 'url'"
								:type="subField.type === 'url' ? 'url' : 'text'"
								class="w-full py-1 px-1.5 text-xs border border-border-subtle rounded bg-bg-surface text-text-primary outline-none transition-[border-color] duration-(--motion-fast) focus:border-brand"
								:value="(item as Record<string, unknown>)[subField.key] ?? ''"
								:placeholder="subField.placeholder"
								@input="(e) => updateItemField(index, subField.key, (e.target as HTMLInputElement).value)"
							/>
							<!-- Toggle sub-field -->
							<button
								v-else-if="subField.type === 'toggle'"
								class="relative w-7 h-4 rounded-lg border-none cursor-pointer p-0 transition-[background] duration-(--motion-moderate)"
								:class="(item as Record<string, unknown>)[subField.key] ? 'bg-brand' : 'bg-border-default'"
								type="button"
								@click="updateItemField(index, subField.key, !(item as Record<string, unknown>)[subField.key])"
							>
								<span
									class="absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform duration-(--motion-moderate)"
									:class="{ 'translate-x-3': (item as Record<string, unknown>)[subField.key] }"
								/>
							</button>
							<!-- Select sub-field -->
							<select
								v-else-if="subField.type === 'select'"
								class="w-full py-1 px-1.5 text-xs border border-border-subtle rounded bg-bg-surface text-text-primary outline-none transition-[border-color] duration-(--motion-fast) focus:border-brand"
								:value="(item as Record<string, unknown>)[subField.key] ?? ''"
								@change="(e) => updateItemField(index, subField.key, (e.target as HTMLSelectElement).value)"
							>
								<option
									v-for="opt in subField.options"
									:key="String(opt.value)"
									:value="opt.value"
								>
									{{ opt.label }}
								</option>
							</select>
						</div>
					</template>
				</div>

				<IconButton
					:icon="Trash2"
					title="Remove"
					size="sm"
					variant="destructive"
					class="shrink-0 opacity-0 group-hover/item:opacity-100 transition-opacity duration-(--motion-fast)"
					@click="removeItem(index)"
				/>
			</div>
		</VueDraggable>

		<ActionButton :icon="Plus" label="Add item" @click="addItem" />
	</div>
</template>
