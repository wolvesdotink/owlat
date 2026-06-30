<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { buildContactsCsv, downloadCsv, type CsvContact } from '~/utils/contactsCsv';

const props = defineProps<{
	totalCount: number;
	searchQuery: string;
	contactProperties:
		| ReadonlyArray<{ readonly _id: Id<'contactProperties'>; readonly label: string }>
		| null
		| undefined;
}>();

const emit = defineEmits<{
	close: [];
}>();

const convex = useConvex();
const { showToast } = useToast();

type ExportContact = {
	_id: Id<'contacts'>;
	email: string;
	firstName?: string;
	lastName?: string;
	language?: string;
	source?: string;
	createdAt?: number;
	updatedAt?: number;
};

const isOpen = defineModel<boolean>('open', { default: false });
const isExporting = ref(false);
const exportOption = ref<'all' | 'filtered'>('all');

watch(isOpen, (newValue) => {
	if (newValue) {
		exportOption.value = props.searchQuery ? 'filtered' : 'all';
	}
});

const handleExport = async () => {
	if (!convex) return;
	isExporting.value = true;

	try {
		const searchTerm = exportOption.value === 'filtered' ? props.searchQuery : undefined;
		const contactsToExport = await convex.query(api.contacts.organization.listForExportByOrganization, {
			search: searchTerm || undefined,
		});

		if (!contactsToExport || contactsToExport.length === 0) {
			showToast('No contacts to export');
			isOpen.value = false;
			return;
		}

		const contactExportIds = (contactsToExport as ExportContact[]).map((c) => c._id);
		const propertyValues = await convex.query(api.contacts.organization.getPropertyValuesForContacts, {
			contactIds: contactExportIds,
		});

		const csv = buildContactsCsv(
			contactsToExport as CsvContact[],
			propertyValues,
			props.contactProperties || [],
		);
		const timestamp = new Date().toISOString().slice(0, 10);
		const filename = `contacts-export-${timestamp}.csv`;
		downloadCsv(csv, filename);

		showToast(
			`Exported ${contactsToExport.length} contact${contactsToExport.length !== 1 ? 's' : ''} to ${filename}`
		);
		isOpen.value = false;
	} catch (error) {
		showToast('Export failed. Please try again.', 'error');
	} finally {
		isExporting.value = false;
	}
};

const close = () => {
	if (!isExporting.value) {
		isOpen.value = false;
	}
};
</script>

<template>
	<UiModal
		:open="isOpen"
		size="md"
		:closable="!isExporting"
		:persistent="isExporting"
		@update:open="(v) => { if (!v) close(); }"
	>
		<div class="flex items-center gap-3 mb-6">
			<div class="p-2 rounded-lg flex items-center justify-center bg-bg-surface">
				<Icon name="lucide:download" class="w-5 h-5 text-brand" />
			</div>
			<div>
				<h2 class="text-lg font-semibold text-text-primary">Export Contacts</h2>
				<p class="text-sm text-text-tertiary">Download as CSV file</p>
			</div>
		</div>
		<div class="mb-6">
			<h4 class="text-sm font-medium text-text-primary mb-3">What to export</h4>
			<div class="space-y-3">
				<UiSelectableListItem
					v-model="exportOption"
					type="radio"
					value="all"
					name="exportOption"
					label="All contacts"
					:description="`Export all ${totalCount} contacts`"
					:disabled="isExporting"
				/>
				<UiSelectableListItem
					v-if="searchQuery"
					v-model="exportOption"
					type="radio"
					value="filtered"
					name="exportOption"
					label="Current search results"
					:description="`Export contacts matching &quot;${searchQuery}&quot;`"
					:disabled="isExporting"
				/>
			</div>
		</div>
		<div class="p-4 rounded-lg bg-bg-surface">
			<h4 class="text-sm font-medium text-text-primary mb-2">Export includes</h4>
			<ul class="text-sm text-text-secondary space-y-1">
				<li>Email, name, and subscription status</li>
				<li>Source, created date, and timestamps</li>
				<li>All custom contact properties</li>
			</ul>
		</div>

		<template #footer>
			<UiButton variant="secondary" :disabled="isExporting" @click="close">Cancel</UiButton>
			<UiButton :loading="isExporting" @click="handleExport">
				<template v-if="!isExporting" #iconLeft><Icon name="lucide:download" class="w-4 h-4" /></template>
				{{ isExporting ? 'Exporting...' : 'Export to CSV' }}
			</UiButton>
		</template>
	</UiModal>
</template>
