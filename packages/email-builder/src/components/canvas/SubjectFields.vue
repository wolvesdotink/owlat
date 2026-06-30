<script setup lang="ts">
import { Plus } from '@lucide/vue';
import type { Variable } from '../../types';
import VariablePlaceholderTag from '../ui/VariablePlaceholderTag.vue';

defineProps<{
	name: string;
	subject: string;
	hideSubject: boolean;
	mode?: string;
	// When set, render the data-variable manager strip. Only the transactional
	// editor (variableType: 'data') passes these — marketing personalization
	// variables come from contact fields and are not user-defined here.
	showDataVariables?: boolean;
	dataVariables?: Variable[];
}>();

const emit = defineEmits<{
	(e: 'update:name', value: string): void;
	(e: 'update:subject', value: string): void;
	(e: 'add-variable'): void;
}>();
</script>

<template>
	<div class="flex flex-col gap-1 pb-4 mb-2 border-b border-border-subtle">
		<div class="flex items-baseline gap-3">
			<label class="text-xs font-medium text-text-secondary w-16 shrink-0 text-right">Name</label>
			<input
				:value="name"
				type="text"
				class="flex-1 bg-transparent text-text-primary font-medium text-sm focus:outline-none border-b border-transparent hover:border-border-default focus:border-brand transition-colors py-0.5"
				:placeholder="mode === 'block' ? 'Block name' : 'Template name'"
				@input="emit('update:name', ($event.target as HTMLInputElement).value)"
			/>
		</div>
		<div v-if="!hideSubject" class="flex items-baseline gap-3">
			<label class="text-xs font-medium text-text-secondary w-16 shrink-0 text-right">Subject</label>
			<input
				:value="subject"
				type="text"
				class="flex-1 bg-transparent text-text-primary text-sm focus:outline-none border-b border-transparent hover:border-border-default focus:border-brand transition-colors py-0.5"
				placeholder="Email subject line"
				@input="emit('update:subject', ($event.target as HTMLInputElement).value)"
			/>
		</div>

		<!-- Data variables manager — the only in-editor affordance to DEFINE a new
		     data variable. Without it a freshly created transactional email has an
		     empty schema and the user can reference variables but never add one. -->
		<div v-if="showDataVariables" class="flex items-baseline gap-3 pt-1">
			<label class="text-xs font-medium text-text-secondary w-16 shrink-0 text-right">Variables</label>
			<div class="flex-1 flex flex-wrap items-center gap-1.5">
				<VariablePlaceholderTag
					v-for="variable in dataVariables"
					:key="variable.key"
					:label="variable.key"
				/>
				<button
					type="button"
					class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-dashed border-border-default text-xs text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary hover:border-border-strong transition-colors"
					title="Define a new data variable for this email"
					@click="emit('add-variable')"
				>
					<Plus :size="12" />
					New variable
				</button>
			</div>
		</div>
	</div>
</template>
