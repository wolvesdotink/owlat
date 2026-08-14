<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { EntryType, SourceType } from '~/utils/knowledgeEntryTypes';

const props = withDefaults(
	defineProps<{
		isEdit?: boolean;
		entryId?: Id<'knowledgeEntries'>;
		initialValues?: {
			entryType?: string;
			title?: string;
			content?: string;
			sourceType?: string;
			confidence?: number;
			tags?: string[];
			expiresAt?: number;
		};
	}>(),
	{
		isEdit: false,
	}
);

const emit = defineEmits<{
	saved: [id: string];
	cancelled: [];
}>();

const { createEntry, updateEntry, ENTRY_TYPES, TYPE_CONFIG, SOURCE_CONFIG } = useKnowledgeGraph();

const { t, te } = useI18n();

// Option labels are translated here: the shared presentation map
// (`~/utils/knowledgeEntryTypes`) stays a plain constant, so a type the catalog
// doesn't know still falls back to its raw label instead of a key path.
const entryTypeLabel = (type: string) => {
	const key = `components.knowledge.entryForm.entryTypes.${type}`;
	return te(key) ? t(key) : (TYPE_CONFIG[type as EntryType]?.label ?? type);
};
const sourceTypeLabel = (source: string) => {
	const key = `components.knowledge.entryForm.sourceTypes.${source}`;
	return te(key) ? t(key) : (SOURCE_CONFIG[source]?.label ?? source);
};

// Seed the "expires in N days" input from the stored absolute timestamp so the
// edit form round-trips an existing expiry instead of silently clearing it.
const initialExpiresInDays = (() => {
	const expiresAt = props.initialValues?.expiresAt;
	if (!expiresAt) return '';
	const days = Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
	return days > 0 ? String(days) : '';
})();

const form = reactive({
	entryType: props.initialValues?.entryType ?? 'fact',
	title: props.initialValues?.title ?? '',
	content: props.initialValues?.content ?? '',
	sourceType: props.initialValues?.sourceType ?? 'manual',
	confidence: props.initialValues?.confidence ?? 0.8,
	tagsInput: (props.initialValues?.tags ?? []).join(', '),
	expiresInDays: initialExpiresInDays,
});

const isSubmitting = ref(false);

const parsedTags = computed(() => {
	if (!form.tagsInput.trim()) return [];
	return form.tagsInput
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);
});

const canSubmit = computed(() => form.title.trim() && form.content.trim());

const handleSubmit = async () => {
	if (!canSubmit.value || isSubmitting.value) return;
	isSubmitting.value = true;

	const expiresAt = form.expiresInDays
		? Date.now() + Number(form.expiresInDays) * 24 * 60 * 60 * 1000
		: undefined;

	const payload = {
		entryType: form.entryType as EntryType,
		title: form.title.trim(),
		content: form.content.trim(),
		sourceType: form.sourceType as SourceType,
		confidence: form.confidence,
		tags: parsedTags.value.length > 0 ? parsedTags.value : undefined,
		expiresAt,
	};

	if (props.isEdit && props.entryId) {
		const result = await updateEntry({ entryId: props.entryId, ...payload });
		isSubmitting.value = false;
		if (result === undefined) return;
		emit('saved', props.entryId as string);
		return;
	}

	const id = await createEntry(payload);

	isSubmitting.value = false;
	if (id === undefined) return;
	emit('saved', id as string);
};

const handleCancel = () => {
	emit('cancelled');
};
</script>

<template>
	<form class="space-y-5" @submit.prevent="handleSubmit">
		<!-- Entry Type -->
		<div>
			<label for="form-entrytype" class="block text-sm font-medium text-text-secondary mb-1.5">{{
				t('components.knowledge.entryForm.type')
			}}</label>
			<select id="form-entrytype" v-model="form.entryType" class="input w-full">
				<option v-for="entryType in ENTRY_TYPES" :key="entryType" :value="entryType">
					{{ entryTypeLabel(entryType) }}
				</option>
			</select>
		</div>

		<!-- Title -->
		<div>
			<label for="form-title" class="block text-sm font-medium text-text-secondary mb-1.5">{{
				t('components.knowledge.entryForm.title')
			}}</label>
			<input
				id="form-title"
				v-model="form.title"
				type="text"
				:placeholder="t('components.knowledge.entryForm.titlePlaceholder')"
				class="input w-full"
			/>
		</div>

		<!-- Content -->
		<div>
			<label for="form-content" class="block text-sm font-medium text-text-secondary mb-1.5">{{
				t('components.knowledge.entryForm.content')
			}}</label>
			<textarea
				id="form-content"
				v-model="form.content"
				:placeholder="t('components.knowledge.entryForm.contentPlaceholder')"
				rows="4"
				class="input w-full resize-none"
			/>
		</div>

		<!-- Source Type -->
		<div>
			<label for="form-sourcetype" class="block text-sm font-medium text-text-secondary mb-1.5">{{
				t('components.knowledge.entryForm.source')
			}}</label>
			<select id="form-sourcetype" v-model="form.sourceType" class="input w-full">
				<option v-for="(config, key) in SOURCE_CONFIG" :key="key" :value="key">
					{{ sourceTypeLabel(String(key)) }}
				</option>
			</select>
		</div>

		<!-- Confidence -->
		<div>
			<label for="form-confidence" class="block text-sm font-medium text-text-secondary mb-1.5">
				{{ t('components.knowledge.entryForm.confidence') }}
				<span class="font-normal text-text-tertiary">{{
					t('components.knowledge.entryForm.confidenceValue', {
						value: Math.round(form.confidence * 100),
					})
				}}</span>
			</label>
			<input
				id="form-confidence"
				v-model.number="form.confidence"
				type="range"
				min="0"
				max="1"
				step="0.05"
				class="w-full accent-brand"
			/>
			<div class="flex justify-between text-xs text-text-tertiary mt-1">
				<span>{{ t('components.knowledge.entryForm.confidenceLow') }}</span>
				<span>{{ t('components.knowledge.entryForm.confidenceHigh') }}</span>
			</div>
		</div>

		<!-- Tags -->
		<div>
			<label for="form-tagsinput" class="block text-sm font-medium text-text-secondary mb-1.5">
				{{ t('components.knowledge.entryForm.tags') }}
				<span class="text-text-tertiary font-normal">{{
					t('components.knowledge.entryForm.tagsHint')
				}}</span>
			</label>
			<input
				id="form-tagsinput"
				v-model="form.tagsInput"
				type="text"
				:placeholder="t('components.knowledge.entryForm.tagsPlaceholder')"
				class="input w-full"
			/>
			<div v-if="parsedTags.length > 0" class="flex flex-wrap gap-1 mt-2">
				<span
					v-for="tag in parsedTags"
					:key="tag"
					class="text-xs px-2 py-0.5 rounded-full bg-bg-surface text-text-secondary border border-border-subtle"
				>
					{{ tag }}
				</span>
			</div>
		</div>

		<!-- Expiration -->
		<div>
			<label for="form-expiresindays" class="block text-sm font-medium text-text-secondary mb-1.5">
				{{ t('components.knowledge.entryForm.expiresIn') }}
				<span class="text-text-tertiary font-normal">{{
					t('components.knowledge.entryForm.expiresInHint')
				}}</span>
			</label>
			<input
				id="form-expiresindays"
				v-model="form.expiresInDays"
				type="number"
				min="1"
				:placeholder="t('components.knowledge.entryForm.expiresInPlaceholder')"
				class="input w-full"
			/>
		</div>

		<!-- Actions -->
		<div class="flex items-center justify-end gap-3 pt-2">
			<UiButton variant="secondary" type="button" @click="handleCancel">{{
				t('common.cancel')
			}}</UiButton>
			<UiButton type="submit" class="gap-2" :disabled="!canSubmit || isSubmitting">
				<UiSpinner v-if="isSubmitting" size="xs" tone="inverse" />
				<Icon v-else name="lucide:plus" class="w-4 h-4" />
				{{
					isEdit
						? t('components.knowledge.entryForm.submitUpdate')
						: t('components.knowledge.entryForm.submitCreate')
				}}
			</UiButton>
		</div>
	</form>
</template>
