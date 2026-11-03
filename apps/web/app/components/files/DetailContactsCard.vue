<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { PencilIcon, UserIcon } from '@coolicons/vue';

/** The file detail page's linked contacts: links to each contact, edited with the multi-select picker. */
const props = defineProps<{
	fileId: Id<'semanticFiles'>;
	contactIds?: Id<'contacts'>[];
	isAdmin: boolean;
}>();

const { t } = useI18n();
const { showToast } = useToast();

const { run: updateFile } = useBackendOperation(api.files.library.update, {
	label: () => t('dashboard.files.detail.updateOperation'),
});

const isEditingContacts = ref(false);
const editContacts = ref<PickerContact[]>([]);

// Hydrate the file's linked contact ids into full rows so the editable picker
// can render labels/chips (the file row carries only ids).
const linkedContactIds = computed(() => props.contactIds ?? []);
const { data: linkedContacts } = useConvexQuery(api.contacts.contacts.getByIds, () => ({
	contactIds: linkedContactIds.value,
}));

const startEditContacts = () => {
	editContacts.value = [...(linkedContacts.value ?? [])];
	isEditingContacts.value = true;
};

const saveContacts = async () => {
	const contactIds = editContacts.value.map((c) => c._id);
	const result = await updateFile({ fileId: props.fileId, contactIds });
	if (!result.ok) return;
	isEditingContacts.value = false;
	showToast(t('dashboard.files.detail.toasts.contactsUpdated'));
};

const cancelEditContacts = () => {
	isEditingContacts.value = false;
};
</script>

<template>
	<div class="bg-bg-elevated shadow-surface-1 rounded-(--radius-card) p-5">
		<div class="flex items-center justify-between mb-3">
			<h3 class="text-sm font-semibold text-text-primary">
				{{ t('dashboard.files.detail.linkedContacts') }}
			</h3>
			<button
				v-if="!isEditingContacts && isAdmin"
				class="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				:aria-label="t('dashboard.files.detail.editLinkedContacts')"
				@click="startEditContacts"
			>
				<PencilIcon class="w-3.5 h-3.5" />
			</button>
		</div>

		<!-- Edit: multi-select contact picker -->
		<div v-if="isEditingContacts" class="space-y-3">
			<FilesContactPicker v-model="editContacts" />
			<div class="flex items-center gap-2">
				<button class="text-xs text-brand font-medium hover:underline" @click="saveContacts">
					{{ t('common.save') }}
				</button>
				<button
					class="text-xs text-text-tertiary hover:text-text-primary"
					@click="cancelEditContacts"
				>
					{{ t('common.cancel') }}
				</button>
			</div>
		</div>

		<!-- Read: linked contacts as links -->
		<div v-else>
			<div v-if="linkedContacts && linkedContacts.length > 0" class="space-y-2">
				<NuxtLink
					v-for="contact in linkedContacts"
					:key="contact._id"
					:to="`/dashboard/audience/contacts/${contact._id}`"
					class="flex items-center gap-2 p-2 -mx-2 rounded-lg hover:bg-bg-surface transition-colors"
				>
					<UserIcon class="w-4 h-4 text-text-tertiary" />
					<span class="text-sm text-brand hover:underline truncate">{{
						contactPickerLabel(contact)
					}}</span>
				</NuxtLink>
			</div>
			<p v-else class="text-sm text-text-tertiary">
				{{ t('dashboard.files.detail.noLinkedContacts') }}
			</p>
		</div>
	</div>
</template>
