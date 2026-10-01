<script setup lang="ts">
import type { TranslationCellStatus } from '~/composables/useTranslationDrafts';

interface Props {
	value: string;
	placeholder?: string;
	isHtml?: boolean;
	isDefault?: boolean;
	/** Saving state of the cell's latest edit. */
	status?: TranslationCellStatus;
	/** The row's field name and the column's language, for the accessible names. */
	fieldLabel?: string;
	languageLabel?: string;
}

const { t } = useI18n();

const props = withDefaults(defineProps<Props>(), {
	placeholder: '',
	isHtml: false,
	isDefault: false,
	status: 'idle',
	fieldLabel: '',
	languageLabel: '',
});

// A caller may name the cell itself; otherwise the shared invitation to edit.
const placeholderText = computed(
	() => props.placeholder || t('components.translation.cell.placeholder')
);

const emit = defineEmits<{
	save: [value: string];
	retry: [];
	discard: [];
	/** The text open in the editor, or null once it closes. */
	edit: [text: string | null];
}>();

const isEditing = ref(false);
const editValue = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const entryRef = ref<HTMLButtonElement | null>(null);

const id = useId();
const valueId = `${id}-value`;
const hintId = `${id}-hint`;
const statusId = `${id}-status`;

const fieldName = computed(() =>
	t('components.translation.cell.fieldName', {
		field: props.fieldLabel,
		language: props.languageLabel,
	})
);

// Strip HTML for display (preserve simple HTML in value)
const displayText = computed(() => {
	if (!props.value) return '';
	// Remove HTML tags for display preview
	return props.value.replace(/<[^>]*>/g, '').trim();
});

const isEmpty = computed(() => !props.value || props.value.trim() === '');
const isSaving = computed(() => props.status === 'saving');
const hasError = computed(() => props.status === 'failed' || props.status === 'conflict');

const startEditing = () => {
	if (props.isDefault) return; // Don't edit default language in translation view
	editValue.value = props.value || '';
	isEditing.value = true;
	nextTick(() => {
		textareaRef.value?.focus();
		textareaRef.value?.select();
	});
};

// Leaving the editor hands focus back to the cell it was opened from.
const closeEditor = () => {
	isEditing.value = false;
	nextTick(() => entryRef.value?.focus());
};

const saveEdit = () => {
	if (editValue.value !== props.value) {
		emit('save', editValue.value);
	}
	closeEditor();
};

const cancelEdit = () => {
	editValue.value = props.value || '';
	closeEditor();
};

const handleKeydown = (e: KeyboardEvent) => {
	if (e.key === 'Escape') {
		// The cell owns this Escape; a dialog or drawer around it must not close.
		e.stopPropagation();
		cancelEdit();
	} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
		e.preventDefault();
		saveEdit();
	}
};

// Report the open editor's text, so unsaved typing counts before it is saved.
watch([isEditing, editValue], ([editing, text]) => emit('edit', editing ? text : null));
// A cell that goes away (its language or row removed) takes its text with it.
onBeforeUnmount(() => {
	if (isEditing.value) emit('edit', null);
});

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
				class="w-full min-h-[80px] p-2 pb-8 text-sm bg-bg-base border border-brand rounded-lg text-text-primary resize-none focus:outline-none focus:ring-1 focus:ring-brand"
				:placeholder="placeholderText"
				:aria-label="fieldName"
				:aria-describedby="hintId"
				@keydown="handleKeydown"
				@input="autoResize"
			/>
			<p :id="hintId" class="sr-only">{{ t('components.translation.cell.editHint') }}</p>
			<div class="absolute bottom-2 right-2 flex gap-1">
				<button
					type="button"
					class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-success transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					:title="t('components.translation.cell.saveTitle')"
					:aria-label="t('components.translation.cell.saveTitle')"
					@click="saveEdit"
				>
					<Icon name="lucide:check" class="w-4 h-4" />
				</button>
				<button
					type="button"
					class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-error transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					:title="t('components.translation.cell.cancelTitle')"
					:aria-label="t('components.translation.cell.cancelTitle')"
					@click="cancelEdit"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>
		</div>

		<!-- Default language: read-only source text -->
		<div
			v-else-if="isDefault"
			class="relative min-h-[40px] p-2 rounded-lg text-sm bg-bg-surface/50"
		>
			<span v-if="isEmpty" class="text-text-tertiary italic">
				{{ t('components.translation.cell.noContent') }}
			</span>
			<span v-else class="text-text-primary break-words" :class="{ 'line-clamp-3': !isHtml }">
				{{ displayText }}
			</span>
			<span class="absolute top-1 right-1 text-xs text-brand bg-brand/10 px-1.5 py-0.5 rounded">
				{{ t('components.translation.cell.sourceBadge') }}
			</span>
		</div>

		<!-- Display Mode: the cell's entry control -->
		<template v-else>
			<button
				ref="entryRef"
				type="button"
				:class="[
					'group relative block w-full min-h-[40px] p-2 rounded-lg text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
					hasError
						? 'border border-error/60 hover:bg-bg-surface'
						: isEmpty
							? 'border border-dashed border-border-subtle hover:border-border-default'
							: 'hover:bg-bg-surface',
					isSaving ? 'opacity-50' : '',
				]"
				:aria-label="t('components.translation.cell.editLabel', { field: fieldName })"
				:aria-describedby="hasError || isSaving ? `${valueId} ${statusId}` : valueId"
				@click="startEditing"
			>
				<!-- Empty state -->
				<span v-if="isEmpty" :id="valueId" class="text-text-tertiary italic">
					{{ placeholderText }}
				</span>

				<!-- Value display -->
				<span
					v-else
					:id="valueId"
					class="text-text-primary break-words"
					:class="{ 'line-clamp-3': !isHtml }"
				>
					{{ displayText }}
				</span>

				<!-- HTML indicator -->
				<span
					v-if="isHtml && !isEmpty"
					class="absolute top-1 right-1 text-xs text-text-tertiary bg-bg-surface px-1 rounded opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
				>
					{{ t('components.translation.cell.htmlBadge') }}
				</span>

				<!-- Saving indicator -->
				<span
					v-if="isSaving"
					class="absolute inset-0 flex items-center justify-center bg-bg-elevated/50 rounded-lg"
				>
					<UiSpinner size="xs" />
				</span>
			</button>

			<!-- Saving / failed state, spelled out rather than left to hover -->
			<p v-if="isSaving" :id="statusId" class="sr-only" role="status">
				{{ t('components.translation.cell.saving') }}
			</p>
			<div v-else-if="hasError" class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
				<p :id="statusId" class="flex items-center gap-1 text-xs text-error" role="alert">
					<Icon name="lucide:alert-circle" class="w-3.5 h-3.5 shrink-0" />
					{{
						status === 'conflict'
							? t('components.translation.cell.conflict')
							: t('components.translation.cell.saveFailed')
					}}
				</p>
				<button
					type="button"
					class="text-xs font-medium text-text-primary underline underline-offset-2 hover:text-brand rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					:aria-label="t('components.translation.cell.retryLabel', { field: fieldName })"
					@click="emit('retry')"
				>
					{{ t('components.translation.cell.retry') }}
				</button>
				<button
					type="button"
					class="text-xs font-medium text-text-secondary underline underline-offset-2 hover:text-error rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					:aria-label="t('components.translation.cell.discardLabel', { field: fieldName })"
					@click="emit('discard')"
				>
					{{ t('components.translation.cell.discard') }}
				</button>
			</div>
		</template>
	</div>
</template>
