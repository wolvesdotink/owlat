<script setup lang="ts">
/** The knowledge entry detail page's linked contacts, each a link to the contact. */
defineProps<{
	contactIds: string[];
}>();

const { t } = useI18n();
</script>

<template>
	<div class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
		<h3 class="text-sm font-semibold text-text-primary mb-3">
			{{ t('dashboard.knowledge.detail.linkedContacts') }}
		</h3>
		<div class="space-y-2">
			<NuxtLink
				v-for="contactId in contactIds"
				:key="contactId"
				:to="`/dashboard/audience/contacts/${contactId}`"
				class="flex items-center gap-2 py-1.5 text-sm text-text-primary hover:text-brand transition-colors"
			>
				<Icon name="lucide:user" class="w-3.5 h-3.5 text-text-tertiary" />
				<span class="truncate">{{ contactId }}</span>
				<Icon name="lucide:external-link" class="w-3 h-3 text-text-tertiary ml-auto" />
			</NuxtLink>
		</div>
	</div>
</template>
