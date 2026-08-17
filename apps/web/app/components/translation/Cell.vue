<script setup lang="ts">
interface Props {
	value: string;
	placeholder?: string;
	isHtml?: boolean;
	isDefault?: boolean;
	isSaving?: boolean;
}

const { t } = useI18n();

const props = withDefaults(defineProps<Props>(), {
	placeholder: '',
	isHtml: false,
	isDefault: false,
	isSaving: false,
});

// A caller may name the cell itself; otherwise the shared invitation to edit.
const placeholderText = computed(
	() => props.placeholder || t('components.translation.cell.placeholder')
);

const emit = defineEmits<{
	save: [value: string];
}>();

const isEditing = ref(false);
const editValue = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);

// Strip HTML for display (preserve simple HTML in value)
const displayText = computed(() => {
	if (!props.value) return '';
	// Remove HTML tags for display preview
	return props.value.replace(/<[^>]*>/g, '').trim();
});

const isEmpty = computed(() => !props.value || props.value.trim() === '');

const startEditing = () => {
	if (props.isDefault) return; // Don't edit default language in translation view
	editValue.value = props.value || '';
	isEditing.value = true;
	nextTick(() => {
		textareaRef.value?.focus();
		textareaRef.value?.select();
	});
};

const saveEdit = () => {
	if (editValue.value !== props.value) {
		emit('save', editValue.value);
	}
	isEditing.value = false;
};

const cancelEdit = () => {
	isEditing.value = false;
	editValue.value = props.value || '';
};

const handleKeydown = (e: KeyboardEvent) => {
	if (e.key === 'Escape') {
		cancelEdit();
	} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
		saveEdit();
	}
};

// Auto-resize textarea
const autoResize = () => {
	if (textareaRef.value) {
		textareaRef.value.style.height = 'auto';
		textareaRef.value.style.height = `${textareaRef.value.scrollHeight}px`;
	}
};

watch(editValue, () => {
	nextTick(autoResize);
});
</script>

<template>
	<div class="relative min-h-[40px]">
		<!-- Editing Mode -->
		<div v-if="isEditing" class="relative">
			<textarea
				ref="textareaRef"
				v-model="editValue"
				class="w-full min-h-[80px] p-2 text-sm bg-bg-base border border-brand rounded-lg text-text-primary resize-none focus:outline-none focus:ring-1 focus:ring-brand"
				:placeholder="placeholderText"
				@keydown="handleKeydown"
				@input="autoResize"
			/>
			<div class="absolute bottom-2 right-2 flex gap-1">
				<button
					type="button"
					class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-success transition-colors"
					:title="t('components.translation.cell.saveTitle')"
					@click="saveEdit"
				>
					<Icon name="lucide:check" class="w-4 h-4" />
				</button>
				<button
					type="button"
					class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-error transition-colors"
					:title="t('components.translation.cell.cancelTitle')"
					@click="cancelEdit"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>
		</div>

		<!-- Display Mode -->
		<div
			v-else
			:class="[
				'group relative min-h-[40px] p-2 rounded-lg text-sm cursor-pointer transition-colors',
				isEmpty && !isDefault
					? 'border border-dashed border-border-subtle hover:border-border-default'
					: 'hover:bg-bg-surface',
				isDefault ? 'cursor-default bg-bg-surface/50' : '',
				isSaving ? 'opacity-50' : '',
			]"
			@click="startEditing"
		>
			<!-- Empty state -->
			<span v-if="isEmpty" class="text-text-tertiary italic">
				{{ isDefault ? t('components.translation.cell.noContent') : placeholderText }}
			</span>

			<!-- Value display -->
			<span v-else class="text-text-primary break-words" :class="{ 'line-clamp-3': !isHtml }">
				{{ displayText }}
			</span>

			<!-- HTML indicator -->
			<span
				v-if="isHtml && !isEmpty"
				class="absolute top-1 right-1 text-xs text-text-tertiary bg-bg-surface px-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
			>
				{{ t('components.translation.cell.htmlBadge') }}
			</span>

			<!-- Default language indicator -->
			<span
				v-if="isDefault"
				class="absolute top-1 right-1 text-xs text-brand bg-brand/10 px-1.5 py-0.5 rounded"
			>
				{{ t('components.translation.cell.sourceBadge') }}
			</span>

			<!-- Saving indicator -->
			<div
				v-if="isSaving"
				class="absolute inset-0 flex items-center justify-center bg-bg-elevated/50 rounded-lg"
			>
				<UiSpinner size="xs" />
			</div>
		</div>
	</div>
</template>
