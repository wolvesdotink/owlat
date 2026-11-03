<script setup lang="ts">
import { UploadIcon } from '@coolicons/vue';

defineProps<{
	csvImport: ReturnType<typeof useCsvImport>;
}>();

const { t } = useI18n();
</script>

<template>
	<div>
		<!-- Function ref: a static dotted-path string ref ("csvImport.fileInputRef")
						never assigns the composable's ref object, so triggerFileInput() was a
						no-op and "click to browse" did nothing. Assign the element directly. -->
		<input
			:ref="
				(el) => {
					csvImport.fileInputRef.value = el as HTMLInputElement | null;
				}
			"
			type="file"
			accept=".csv"
			class="hidden"
			@change="csvImport.handleFileSelect"
		/>
		<div
			:ref="
				(el) => {
					csvImport.dropRootRef.value = el as HTMLElement | null;
				}
			"
			:class="[
				'border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer',
				csvImport.isDragging.value
					? 'border-brand bg-brand/5'
					: 'border-border-subtle hover:border-border-default',
			]"
			@click="csvImport.triggerFileInput()"
			@dragover="csvImport.handleDragOver"
			@dragleave="csvImport.handleDragLeave"
			@drop="csvImport.handleDrop"
		>
			<div class="flex flex-col items-center gap-4">
				<div class="p-4 rounded-full bg-bg-surface">
					<UploadIcon class="w-8 h-8 text-text-tertiary" :stroke-width="1.5" />
				</div>
				<div>
					<p class="text-text-primary font-medium">
						{{ t('components.contacts.csvImportModal.upload.dropzone') }}
					</p>
					<p class="text-sm text-text-tertiary mt-1">
						{{ t('components.contacts.csvImportModal.upload.supports') }}
					</p>
				</div>
			</div>
		</div>
		<div class="mt-6 p-4 rounded-lg bg-bg-surface">
			<h4 class="text-sm font-medium text-text-primary mb-2">
				{{ t('components.contacts.csvImportModal.upload.tipsTitle') }}
			</h4>
			<ul class="text-sm text-text-secondary space-y-1">
				<li>{{ t('components.contacts.csvImportModal.upload.tips.headers') }}</li>
				<li>{{ t('components.contacts.csvImportModal.upload.tips.emailColumn') }}</li>
				<li>{{ t('components.contacts.csvImportModal.upload.tips.optionalColumns') }}</li>
				<li>{{ t('components.contacts.csvImportModal.upload.tips.customProperty') }}</li>
			</ul>
		</div>
	</div>
</template>
