<script setup lang="ts">
const props = defineProps<{
	blocklistImport: ReturnType<typeof useBlocklistImport>;
}>();

const emit = defineEmits<{
	import: [];
}>();

const { t } = useI18n();

const stepDescription = computed(() => {
	switch (props.blocklistImport.step.value) {
		case 'upload':
			return t('components.audience.suppressionsImportModal.steps.upload');
		case 'preview':
			return t('components.audience.suppressionsImportModal.steps.preview');
		case 'importing':
			return t('components.audience.suppressionsImportModal.steps.importing');
		case 'complete':
			return t('components.audience.suppressionsImportModal.steps.complete');
		default:
			return '';
	}
});

const canClose = computed(() => props.blocklistImport.step.value !== 'importing');
</script>

<template>
	<UiModal
		:open="blocklistImport.isOpen.value"
		size="lg"
		:closable="canClose"
		:persistent="!canClose"
		@update:open="
			(v) => {
				if (!v) blocklistImport.close();
			}
		"
	>
		<!-- Header -->
		<div class="flex items-center gap-3 mb-6">
			<UiIconBox icon="lucide:file-up" size="sm" variant="surface" rounded="lg" />
			<div>
				<h2 class="text-lg font-semibold text-text-primary">
					{{ t('components.audience.suppressionsImportModal.title') }}
				</h2>
				<p class="text-sm text-text-tertiary">{{ stepDescription }}</p>
			</div>
		</div>

		<!-- Content -->
		<div class="max-h-[70vh] overflow-y-auto">
			<!-- Error Alert -->
			<div
				v-if="blocklistImport.error.value"
				class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20 flex items-start gap-3"
			>
				<Icon name="lucide:alert-circle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
				<p class="text-sm text-error">{{ blocklistImport.error.value }}</p>
			</div>

			<!-- Step 1: Upload -->
			<div v-if="blocklistImport.step.value === 'upload'">
				<input
					:ref="
						(el) => {
							blocklistImport.fileInputRef.value = el as HTMLInputElement | null;
						}
					"
					type="file"
					accept=".csv,.txt"
					class="hidden"
					@change="blocklistImport.handleFileSelect"
				/>
				<div
					:class="[
						'border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer',
						blocklistImport.isDragging.value
							? 'border-brand bg-brand/5'
							: 'border-border-subtle hover:border-border-default',
					]"
					@click="blocklistImport.triggerFileInput()"
					@dragover="blocklistImport.handleDragOver"
					@dragleave="blocklistImport.handleDragLeave"
					@drop="blocklistImport.handleDrop"
				>
					<div class="flex flex-col items-center gap-4">
						<div class="p-4 rounded-full bg-bg-surface">
							<Icon name="lucide:upload" class="w-8 h-8 text-text-tertiary" />
						</div>
						<div>
							<p class="text-text-primary font-medium">
								{{ t('components.audience.suppressionsImportModal.dropzoneTitle') }}
							</p>
							<p class="text-sm text-text-tertiary mt-1">
								{{ t('components.audience.suppressionsImportModal.dropzoneHint') }}
							</p>
						</div>
					</div>
				</div>
				<div class="mt-6 p-4 rounded-lg bg-bg-surface">
					<h4 class="text-sm font-medium text-text-primary mb-2">
						{{ t('components.audience.suppressionsImportModal.formatTipsTitle') }}
					</h4>
					<ul class="text-sm text-text-secondary space-y-1">
						<li>{{ t('components.audience.suppressionsImportModal.formatTips.perLine') }}</li>
						<li>{{ t('components.audience.suppressionsImportModal.formatTips.headerRow') }}</li>
						<li>{{ t('components.audience.suppressionsImportModal.formatTips.skipped') }}</li>
						<li>{{ t('components.audience.suppressionsImportModal.formatTips.manual') }}</li>
					</ul>
				</div>
			</div>

			<!-- Step 2: Preview -->
			<div v-else-if="blocklistImport.step.value === 'preview' && blocklistImport.validation.value">
				<div class="grid grid-cols-3 gap-3 mb-4">
					<div class="p-3 rounded-lg bg-success/10 border border-success/20">
						<p class="text-2xl font-medium tracking-[-0.02em] text-success">
							{{ blocklistImport.validation.value.valid.length }}
						</p>
						<p class="text-xs text-success/80">
							{{ t('components.audience.suppressionsImportModal.validAddresses') }}
						</p>
					</div>
					<div
						class="p-3 rounded-lg"
						:class="
							blocklistImport.validation.value.invalid.length > 0
								? 'bg-warning/10 border border-warning/20'
								: 'bg-bg-surface border border-border-subtle'
						"
					>
						<p
							class="text-2xl font-medium tracking-[-0.02em]"
							:class="
								blocklistImport.validation.value.invalid.length > 0
									? 'text-warning'
									: 'text-text-tertiary'
							"
						>
							{{ blocklistImport.validation.value.invalid.length }}
						</p>
						<p
							class="text-xs"
							:class="
								blocklistImport.validation.value.invalid.length > 0
									? 'text-warning/80'
									: 'text-text-tertiary'
							"
						>
							{{ t('components.audience.suppressionsImportModal.invalid') }}
						</p>
					</div>
					<div
						class="p-3 rounded-lg"
						:class="
							blocklistImport.validation.value.duplicates > 0
								? 'bg-warning/10 border border-warning/20'
								: 'bg-bg-surface border border-border-subtle'
						"
					>
						<p
							class="text-2xl font-medium tracking-[-0.02em]"
							:class="
								blocklistImport.validation.value.duplicates > 0
									? 'text-warning'
									: 'text-text-tertiary'
							"
						>
							{{ blocklistImport.validation.value.duplicates }}
						</p>
						<p
							class="text-xs"
							:class="
								blocklistImport.validation.value.duplicates > 0
									? 'text-warning/80'
									: 'text-text-tertiary'
							"
						>
							{{ t('components.audience.suppressionsImportModal.duplicates') }}
						</p>
					</div>
				</div>

				<p class="text-sm text-text-secondary mb-2">
					{{
						t('components.audience.suppressionsImportModal.previewSummary', {
							shown: Math.min(10, blocklistImport.validation.value.valid.length),
							total: blocklistImport.validation.value.valid.length,
						})
					}}
				</p>
				<div class="rounded-lg border border-border-subtle divide-y divide-border-subtle">
					<div
						v-for="email in blocklistImport.validation.value.valid.slice(0, 10)"
						:key="email"
						class="px-4 py-2 text-sm text-text-primary flex items-center gap-2"
					>
						<Icon name="lucide:check-circle" class="w-4 h-4 text-success shrink-0" />
						{{ email }}
					</div>
				</div>

				<div
					v-if="blocklistImport.validation.value.invalid.length > 0"
					class="mt-4 p-3 rounded-lg bg-warning/5 border border-warning/20"
				>
					<h5 class="text-sm font-medium text-warning mb-1">
						{{ t('components.audience.suppressionsImportModal.skippedInvalidFormat') }}
					</h5>
					<ul class="text-xs text-text-secondary space-y-0.5">
						<li
							v-for="(entry, index) in blocklistImport.validation.value.invalid.slice(0, 10)"
							:key="index"
						>
							{{ entry }}
						</li>
						<li
							v-if="blocklistImport.validation.value.invalid.length > 10"
							class="text-text-tertiary"
						>
							{{
								t('components.audience.suppressionsImportModal.andMore', {
									count: blocklistImport.validation.value.invalid.length - 10,
								})
							}}
						</li>
					</ul>
				</div>
			</div>

			<!-- Step 3: Importing -->
			<div v-else-if="blocklistImport.step.value === 'importing'" class="py-8">
				<div class="flex flex-col items-center gap-6">
					<div class="relative">
						<div class="w-20 h-20 rounded-full border-4 border-bg-surface" />
						<div
							class="absolute inset-0 w-20 h-20 rounded-full border-4 border-brand border-t-transparent animate-spin motion-reduce:animate-none"
						/>
					</div>
					<p class="text-lg font-medium text-text-primary">
						{{ t('components.audience.suppressionsImportModal.steps.importing') }}
					</p>
				</div>
			</div>

			<!-- Step 4: Complete -->
			<div v-else-if="blocklistImport.step.value === 'complete'" class="py-4">
				<div class="flex flex-col items-center gap-4 mb-6">
					<div class="p-3 rounded-full bg-success/10">
						<Icon name="lucide:check" class="w-8 h-8 text-success" />
					</div>
					<p class="text-lg font-medium text-text-primary">
						{{ t('components.audience.suppressionsImportModal.completeTitle') }}
					</p>
				</div>
				<div class="grid grid-cols-2 gap-4 mb-6">
					<UiStatCard
						:value="blocklistImport.results.value?.added || 0"
						:label="t('components.audience.suppressionsImportModal.added')"
						variant="success"
					/>
					<UiStatCard
						:value="blocklistImport.results.value?.skipped || 0"
						:label="t('components.audience.suppressionsImportModal.skipped')"
						variant="secondary"
					/>
				</div>
				<div
					v-if="
						blocklistImport.results.value?.errors && blocklistImport.results.value.errors.length > 0
					"
					class="p-4 rounded-lg bg-error-subtle border border-error/20"
				>
					<h4 class="text-sm font-medium text-error mb-2">
						{{
							t('components.audience.suppressionsImportModal.errorsHeading', {
								count: blocklistImport.results.value.errors.length,
							})
						}}
					</h4>
					<ul class="text-sm text-error/80 space-y-1">
						<li
							v-for="(err, index) in blocklistImport.results.value.errors.slice(0, 5)"
							:key="index"
						>
							{{ err }}
						</li>
					</ul>
				</div>
			</div>
		</div>

		<!-- Footer -->
		<template #footer>
			<template v-if="blocklistImport.step.value === 'upload'">
				<UiButton variant="secondary" @click="blocklistImport.close()">{{
					t('common.cancel')
				}}</UiButton>
			</template>
			<template v-else-if="blocklistImport.step.value === 'preview'">
				<UiButton variant="secondary" @click="blocklistImport.goBackToUpload()">{{
					t('common.back')
				}}</UiButton>
				<UiButton :disabled="!blocklistImport.canImport.value" @click="emit('import')">
					<template #iconLeft><Icon name="lucide:upload" class="w-4 h-4" /></template>
					{{
						t('components.audience.suppressionsImportModal.importAddresses', {
							count: blocklistImport.validCount.value,
						})
					}}
				</UiButton>
			</template>
			<template v-else-if="blocklistImport.step.value === 'complete'">
				<UiButton @click="blocklistImport.close()">{{ t('common.done') }}</UiButton>
			</template>
		</template>
	</UiModal>
</template>
