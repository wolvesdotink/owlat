<script setup lang="ts">
/** The knowledge entry detail page's linked contacts, each a link to the contact. */
import { ExternalLinkIcon, UserIcon } from '@coolicons/vue';

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
				<UserIcon class="w-3.5 h-3.5 text-text-tertiary" />
				<span class="truncate">{{ contactId }}</span>
				<ExternalLinkIcon class="w-3 h-3 text-text-tertiary ml-auto" />
			</NuxtLink>
		</div>
	</div>
</template>
