<script setup lang="ts">
import type { ValidationResult } from '~/composables/useCsvImport';
import { ChevronRightIcon } from '@coolicons/vue';

defineProps<{
	validationResult: ValidationResult | null;
}>();

/** The modal holds it, so the panel stays as the operator left it across steps. */
const showValidationDetails = defineModel<boolean>('open', { required: true });

const { t } = useI18n();
</script>

<template>
	<div class="mt-4">
		<button
			class="flex items-center gap-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
			@click="showValidationDetails = !showValidationDetails"
		>
			<ChevronRightIcon
				class="w-4 h-4 transition-transform"
				:class="{ 'rotate-90': showValidationDetails }"
			/>
			{{ t('components.contacts.csvImportModal.preview.viewIssues') }}
		</button>
		<div v-if="showValidationDetails && validationResult" class="mt-2 space-y-3">
			<div
				v-if="validationResult.invalidEmails.length > 0"
				class="p-3 rounded-lg bg-warning/5 border border-warning/20"
			>
				<h5 class="text-sm font-medium text-warning mb-1">
					{{ t('components.contacts.csvImportModal.preview.invalidEmailsTitle') }}
				</h5>
				<ul class="text-xs text-text-secondary space-y-0.5">
					<I18nT
						v-for="entry in validationResult.invalidEmails.slice(0, 10)"
						:key="entry.row"
						keypath="components.contacts.csvImportModal.preview.rowEntry"
						tag="li"
						scope="global"
					>
						<template #row>{{ entry.row }}</template>
						<template #value>
							<span class="text-text-primary">{{ entry.email }}</span>
						</template>
					</I18nT>
					<li v-if="validationResult.invalidEmails.length > 10" class="text-text-tertiary">
						{{
							t('components.contacts.csvImportModal.preview.andMore', {
								count: validationResult.invalidEmails.length - 10,
							})
						}}
					</li>
				</ul>
			</div>
			<div
				v-if="validationResult.duplicateEmails.length > 0"
				class="p-3 rounded-lg bg-warning/5 border border-warning/20"
			>
				<h5 class="text-sm font-medium text-warning mb-1">
					{{ t('components.contacts.csvImportModal.preview.duplicateEmailsTitle') }}
				</h5>
				<ul class="text-xs text-text-secondary space-y-0.5">
					<I18nT
						v-for="entry in validationResult.duplicateEmails.slice(0, 10)"
						:key="entry.row"
						keypath="components.contacts.csvImportModal.preview.rowEntry"
						tag="li"
						scope="global"
					>
						<template #row>{{ entry.row }}</template>
						<template #value>
							<span class="text-text-primary">{{ entry.email }}</span>
						</template>
					</I18nT>
					<li v-if="validationResult.duplicateEmails.length > 10" class="text-text-tertiary">
						{{
							t('components.contacts.csvImportModal.preview.andMore', {
								count: validationResult.duplicateEmails.length - 10,
							})
						}}
					</li>
				</ul>
			</div>
			<div
				v-if="validationResult.missingEmails.length > 0"
				class="p-3 rounded-lg bg-error-subtle border border-error/20"
			>
				<h5 class="text-sm font-medium text-error mb-1">
					{{ t('components.contacts.csvImportModal.preview.missingEmailsTitle') }}
				</h5>
				<ul class="text-xs text-text-secondary space-y-0.5">
					<I18nT
						v-for="rowNum in validationResult.missingEmails.slice(0, 10)"
						:key="rowNum"
						keypath="components.contacts.csvImportModal.preview.rowEntry"
						tag="li"
						scope="global"
					>
						<template #row>{{ rowNum }}</template>
						<template #value>
							<span class="text-text-tertiary">{{
								t('components.contacts.csvImportModal.emptyCell')
							}}</span>
						</template>
					</I18nT>
					<li v-if="validationResult.missingEmails.length > 10" class="text-text-tertiary">
						{{
							t('components.contacts.csvImportModal.preview.andMore', {
								count: validationResult.missingEmails.length - 10,
							})
						}}
					</li>
				</ul>
			</div>
		</div>
	</div>
</template>
