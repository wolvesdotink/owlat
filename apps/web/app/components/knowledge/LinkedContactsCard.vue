<script setup lang="ts">
/** The knowledge entry detail page's linked contacts, each a link to the contact. */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { ExternalLinkIcon, UserIcon } from '@coolicons/vue';

const props = defineProps<{
	contactIds: string[];
}>();

const { t } = useI18n();

// The entry carries only ids; resolve them to names/emails in one batched read.
// `getByIds` drops deleted contacts, so an id it does not return is shown as a
// deleted contact rather than as a raw id.
const { data: contacts, isLoading } = useConvexQuery(api.contacts.contacts.getByIds, () => ({
	contactIds: props.contactIds as Id<'contacts'>[],
}));

const rows = computed(() => {
	const byId = new Map((contacts.value ?? []).map((c) => [c._id as string, c]));
	return props.contactIds.map((id) => {
		const contact = byId.get(id);
		return { id, label: contact ? contactPickerLabel(contact) : null };
	});
});
</script>

<template>
	<div class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
		<h3 class="text-sm font-semibold text-text-primary mb-3">
			{{ t('dashboard.knowledge.detail.linkedContacts') }}
		</h3>
		<div v-if="isLoading && !contacts" class="space-y-2" aria-hidden="true">
			<UiSkeleton v-for="id in contactIds" :key="id" class="h-5 w-3/4" />
		</div>
		<div v-else class="space-y-2">
			<template v-for="row in rows" :key="row.id">
				<NuxtLink
					v-if="row.label"
					:to="`/dashboard/audience/contacts/${row.id}`"
					class="flex items-center gap-2 py-1.5 text-sm text-text-primary hover:text-brand transition-colors"
				>
					<UserIcon class="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" aria-hidden="true" />
					<span class="truncate" :title="row.label">{{ row.label }}</span>
					<ExternalLinkIcon
						class="w-3 h-3 text-text-tertiary ml-auto flex-shrink-0"
						aria-hidden="true"
					/>
				</NuxtLink>
				<p v-else class="flex items-center gap-2 py-1.5 text-sm text-text-tertiary">
					<UserIcon class="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
					<span class="truncate">{{
						t('components.knowledge.shareWithMembers.deletedContact')
					}}</span>
				</p>
			</template>
		</div>
	</div>
</template>
