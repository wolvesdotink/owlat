<script setup lang="ts">
import { computed } from 'vue';
import type { PropertyField } from '../../schema/types';
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

const isStringArray = computed(() => {
	return items.value.length > 0 && typeof items.value[0] === 'string';
});

function addItem() {
	const newItem = props.field.itemDefault
		? props.field.itemDefault()
		: isStringArray.value
			? ''
			: {};
	emit('update', [...items.value, newItem]);
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
			<div v-for="(item, index) in items" :key="index" class="group/item flex items-start gap-1 p-1.5 border border-border-subtle rounded-lg bg-bg-surface transition-[border-color] duration-[120ms] hover:border-border-strong">
				<div class="array-editor-drag-handle flex items-center py-1 cursor-grab text-text-tertiary opacity-0 group-hover/item:opacity-100 transition-opacity duration-[120ms] active:cursor-grabbing">
					<GripVertical :size="12" />
				</div>

				<div class="flex-1 flex flex-col gap-1 min-w-0">
					<!-- String array: simple text input -->
					<template v-if="isStringArray">
						<input
							type="text"
							class="w-full py-1 px-1.5 text-xs border border-border-subtle rounded bg-bg-surface text-text-primary outline-none transition-[border-color] duration-150 focus:border-brand"
							:value="item as string"
							@input="(e) => updateItem(index, (e.target as HTMLInputElement).value)"
						/>
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
								class="w-full py-1 px-1.5 text-xs border border-border-subtle rounded bg-bg-surface text-text-primary outline-none transition-[border-color] duration-150 focus:border-brand"
								:value="(item as Record<string, unknown>)[subField.key] ?? ''"
								:placeholder="subField.placeholder"
								@input="(e) => updateItemField(index, subField.key, (e.target as HTMLInputElement).value)"
							/>
							<!-- Toggle sub-field -->
							<button
								v-else-if="subField.type === 'toggle'"
								class="relative w-7 h-4 rounded-lg border-none cursor-pointer p-0 transition-[background] duration-200"
								:class="(item as Record<string, unknown>)[subField.key] ? 'bg-brand' : 'bg-border-default'"
								type="button"
								@click="updateItemField(index, subField.key, !(item as Record<string, unknown>)[subField.key])"
							>
								<span
									class="absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform duration-150"
									:class="{ 'translate-x-3': (item as Record<string, unknown>)[subField.key] }"
								/>
							</button>
							<!-- Select sub-field -->
							<select
								v-else-if="subField.type === 'select'"
								class="w-full py-1 px-1.5 text-xs border border-border-subtle rounded bg-bg-surface text-text-primary outline-none transition-[border-color] duration-150 focus:border-brand"
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
					class="shrink-0 opacity-0 group-hover/item:opacity-100 transition-opacity duration-[120ms]"
					@click="removeItem(index)"
				/>
			</div>
		</VueDraggable>

		<ActionButton :icon="Plus" label="Add item" @click="addItem" />
	</div>
</template>
