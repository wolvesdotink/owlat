<script setup lang="ts">
defineProps<{
	csvImport: ReturnType<typeof useCsvImport>;
	availableLists: Array<{ _id: string; name: string }>;
}>();

const { t } = useI18n();
</script>

<template>
	<div>
		<div class="mb-4">
			<I18nT
				keypath="components.contacts.csvImportModal.listMapping.found"
				tag="p"
				class="text-sm text-text-secondary"
				scope="global"
				:plural="csvImport.detectedListNames.value.length"
			>
				<template #count>
					<span class="text-text-primary font-medium">{{
						csvImport.detectedListNames.value.length
					}}</span>
				</template>
			</I18nT>
		</div>
		<div class="space-y-3">
			<div
				v-for="name in csvImport.detectedListNames.value"
				:key="name"
				class="flex items-center gap-4 p-3 rounded-lg bg-bg-surface"
			>
				<div class="flex-1 min-w-0">
					<p class="text-sm font-medium text-text-primary truncate">{{ name }}</p>
				</div>
				<select
					:value="csvImport.listNameMapping.value[name] ?? ''"
					class="input w-56 shrink-0"
					@change="
						csvImport.listNameMapping.value[name] =
							($event.target as HTMLSelectElement).value || null
					"
				>
					<option value="">
						{{ t('components.contacts.csvImportModal.listMapping.skip') }}
					</option>
					<option v-for="list in availableLists" :key="list._id" :value="list._id">
						{{ list.name }}
					</option>
				</select>
			</div>
		</div>
		<div
			v-if="csvImport.detectedListNames.value.length === 0"
			class="p-4 rounded-lg bg-warning-subtle border border-warning/20"
		>
			<p class="text-sm text-warning">
				{{ t('components.contacts.csvImportModal.listMapping.noneFound') }}
			</p>
		</div>
	</div>
</template>
