<script setup lang="ts">
import { mappableFields, type MappableField } from '~/composables/useCsvImport';
import { isScalarField } from '~/utils/csvImportMapping';

const props = defineProps<{
	csvImport: ReturnType<typeof useCsvImport>;
	availableLists: Array<{ _id: string; name: string }>;
}>();

/**
 * Read out when a pick moves a field off another column, which changes that
 * select too. The modal holds it, so it outlives this step like the mapping.
 */
const mappingAnnouncement = defineModel<string>('announcement', { required: true });

const { t } = useI18n();

/**
 * An option's label in one column's select. A scalar field another column owns
 * names that column, so picking it reads as the move it is.
 */
const fieldOptionLabel = (field: { value: MappableField; label: string }, column: number) => {
	if (!isScalarField(field.value)) return t(field.label);
	const owner = props.csvImport.scalarOwners.value[field.value];
	if (owner === undefined || owner === column) return t(field.label);
	return t('components.contacts.csvImportModal.mapping.fieldTaken', {
		field: t(`shared.useCsvImport.fieldNames.${field.value}`),
		column: props.csvImport.csvHeaders.value[owner] ?? '',
	});
};

const onMappingChange = (column: number, event: Event) => {
	const field = (event.target as HTMLSelectElement).value as MappableField;
	const displaced = props.csvImport.mapColumn(column, field);
	const headers = props.csvImport.csvHeaders.value;
	mappingAnnouncement.value = displaced
		.map((index) =>
			t(
				props.csvImport.columnMapping.value[index] === 'property'
					? 'components.contacts.csvImportModal.mapping.fieldMovedToProperty'
					: 'components.contacts.csvImportModal.mapping.fieldMovedToIgnore',
				{
					field: t(`shared.useCsvImport.fieldNames.${field}`),
					from: headers[index]?.trim() || t('components.contacts.csvImportModal.emptyCell'),
					to: headers[column] ?? '',
				}
			)
		)
		.join(' ');
};
</script>

<template>
	<div>
		<div class="mb-4">
			<I18nT
				keypath="components.contacts.csvImportModal.mapping.found"
				tag="p"
				class="text-sm text-text-secondary"
				scope="global"
			>
				<template #count>
					<span class="text-text-primary font-medium">{{ csvImport.totalRowCount.value }}</span>
				</template>
				<template #filename>
					<span class="text-text-primary font-medium">{{
						csvImport.selectedFile.value?.name
					}}</span>
				</template>
			</I18nT>
		</div>
		<div class="space-y-3 mb-6">
			<div
				v-for="(header, index) in csvImport.csvHeaders.value"
				:key="index"
				class="flex items-center gap-4 p-3 rounded-lg bg-bg-surface"
			>
				<div class="flex-1 min-w-0">
					<p class="text-sm font-medium text-text-primary truncate">{{ header }}</p>
					<p class="text-xs text-text-tertiary truncate">
						{{
							t('components.contacts.csvImportModal.mapping.sample', {
								value:
									csvImport.parsedData.value[0]?.[index] ||
									t('components.contacts.csvImportModal.emptyCell'),
							})
						}}
					</p>
				</div>
				<select
					:value="csvImport.columnMapping.value[index]"
					class="input w-48 shrink-0"
					:aria-label="
						t('components.contacts.csvImportModal.mapping.selectLabel', { column: header })
					"
					:disabled="
						csvImport.listAssignmentMode.value === 'global' &&
						csvImport.columnMapping.value[index] === 'topic'
					"
					@change="onMappingChange(index, $event)"
				>
					<option
						v-for="field in mappableFields"
						:key="field.value"
						:value="field.value"
						:disabled="field.value === 'topic' && csvImport.listAssignmentMode.value === 'global'"
					>
						{{ fieldOptionLabel(field, index) }}
					</option>
				</select>
			</div>
		</div>
		<p class="sr-only" role="status" aria-live="polite">{{ mappingAnnouncement }}</p>

		<!-- Handle Duplicates -->
		<div class="p-4 rounded-lg bg-bg-surface">
			<h4 class="text-sm font-medium text-text-primary mb-3">
				{{ t('components.contacts.csvImportModal.mapping.handleDuplicates') }}
			</h4>
			<div class="flex gap-4">
				<label class="flex items-center gap-2 cursor-pointer">
					<input
						v-model="csvImport.handleDuplicates.value"
						type="radio"
						value="skip"
						class="w-4 h-4 text-brand"
					/>
					<span class="text-sm text-text-secondary">{{
						t('components.contacts.csvImportModal.mapping.skipDuplicates')
					}}</span>
				</label>
				<label class="flex items-center gap-2 cursor-pointer">
					<input
						v-model="csvImport.handleDuplicates.value"
						type="radio"
						value="update"
						class="w-4 h-4 text-brand"
					/>
					<span class="text-sm text-text-secondary">{{
						t('components.contacts.csvImportModal.mapping.updateExisting')
					}}</span>
				</label>
			</div>
		</div>

		<!-- Add to Topic -->
		<div v-if="availableLists.length > 0" class="mt-4 p-4 rounded-lg bg-bg-surface">
			<h4 class="text-sm font-medium text-text-primary mb-3">
				{{ t('components.contacts.csvImportModal.mapping.addToTopic') }}
			</h4>
			<select
				:value="csvImport.selectedTopicId.value ?? ''"
				class="input w-full"
				:disabled="csvImport.isTopicMapped.value"
				@change="csvImport.selectGlobalTopic(($event.target as HTMLSelectElement).value || null)"
			>
				<option value="">{{ t('common.none') }}</option>
				<option v-for="list in availableLists" :key="list._id" :value="list._id">
					{{ list.name }}
				</option>
			</select>
			<p v-if="csvImport.isTopicMapped.value" class="text-xs text-text-tertiary mt-2">
				{{ t('components.contacts.csvImportModal.mapping.topicMappedHint') }}
			</p>
			<p v-else class="text-xs text-text-tertiary mt-2">
				{{ t('components.contacts.csvImportModal.mapping.globalTopicHint') }}
			</p>
		</div>
	</div>
</template>
