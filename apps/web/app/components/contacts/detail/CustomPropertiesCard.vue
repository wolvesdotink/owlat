<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

type Property = { _id: Id<'contactProperties'>; label: string; type: string };

// The contact page's "Custom properties" card: one input per property while
// the page is editing, otherwise each label beside its formatted value.
defineProps<{
	properties: ReadonlyArray<Property>;
	isEditing: boolean;
	/** The page's property draft, keyed by property id; the inputs write into it in place. */
	form: Record<string, string>;
	/** The stored value as the reader should see it (Yes/No, a localized date); empty when unset. */
	displayValue: (property: Property) => string | null;
}>();

const { t } = useI18n();
</script>

<template>
	<div class="card">
		<h2 class="text-lg font-medium text-text-primary mb-4">
			{{ t('dashboard.audience.contacts.detail.customProperties') }}
		</h2>

		<!-- Edit mode: one input per property -->
		<div v-if="isEditing" class="grid gap-4 2xl:grid-cols-2 2xl:gap-x-8">
			<div v-for="property in properties" :key="property._id">
				<label class="label">{{ property.label }}</label>
				<select v-if="property.type === 'boolean'" v-model="form[property._id]" class="input">
					<option value="">{{ t('dashboard.audience.contacts.detail.notSet') }}</option>
					<option value="true">{{ t('common.yes') }}</option>
					<option value="false">{{ t('common.no') }}</option>
				</select>
				<input
					v-else
					v-model="form[property._id]"
					:type="property.type === 'number' ? 'number' : property.type === 'date' ? 'date' : 'text'"
					class="input"
					:placeholder="property.label"
				/>
			</div>
		</div>

		<!-- Read mode: label and value share a row; two columns on wide
		     screens keep them within reading distance. -->
		<div v-else class="grid gap-x-8 gap-y-4 2xl:grid-cols-2">
			<div
				v-for="property in properties"
				:key="property._id"
				class="flex items-center justify-between gap-4 py-2 border-b border-border-subtle last:border-b-0 2xl:[&:nth-last-child(2):nth-child(odd)]:border-b-0"
			>
				<span class="text-text-secondary">{{ property.label }}</span>
				<span :class="displayValue(property) ? 'text-text-primary' : 'text-text-tertiary'">
					{{ displayValue(property) || t('dashboard.audience.contacts.detail.notSet') }}
				</span>
			</div>
		</div>
	</div>
</template>
