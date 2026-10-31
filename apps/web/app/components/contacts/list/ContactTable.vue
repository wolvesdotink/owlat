<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

type Contact = {
	_id: Id<'contacts'>;
	email?: string;
	firstName?: string | null;
	lastName?: string | null;
	createdAt: number;
};

// The contacts list's table from `md` up: a select-all header, the Created
// sort, and one ContactsContactRow per contact.
defineProps<{
	contacts: ReadonlyArray<Contact>;
	selectedIds: ReadonlySet<Id<'contacts'>>;
	canManage: boolean;
	isAllPageSelected: boolean;
	isSomePageSelected: boolean;
	/** False while a search is active: results are relevance-ordered, so Created claims no sort. */
	sortApplies: boolean;
	createdAriaSort: 'ascending' | 'descending' | undefined;
	createdSortIcon: string | null;
	contactPath: (contactId: Id<'contacts'>) => string;
}>();

const emit = defineEmits<{
	'toggle-select-all': [];
	'toggle-sort': [];
	'toggle-select': [contactId: Id<'contacts'>];
	open: [contactId: Id<'contacts'>];
}>();

const { t } = useI18n();
</script>

<template>
	<div class="overflow-x-auto">
		<table class="w-full">
			<thead>
				<tr class="border-b border-border-subtle">
					<th v-if="canManage" class="w-12 px-4 py-4 density-compact:py-2">
						<UiCheckbox
							:model-value="isAllPageSelected"
							:indeterminate="isSomePageSelected"
							:aria-label="t('dashboard.audience.contacts.index.selectAllLoaded')"
							@update:model-value="emit('toggle-select-all')"
						/>
					</th>
					<th
						class="text-left px-6 py-4 density-compact:py-2 text-sm font-medium text-text-secondary"
					>
						{{ t('common.email') }}
					</th>
					<th
						class="text-left px-6 py-4 density-compact:py-2 text-sm font-medium text-text-secondary"
					>
						{{ t('dashboard.audience.contacts.index.table.firstName') }}
					</th>
					<th
						class="text-left px-6 py-4 density-compact:py-2 text-sm font-medium text-text-secondary"
					>
						{{ t('dashboard.audience.contacts.index.table.lastName') }}
					</th>
					<th
						class="text-left px-6 py-4 density-compact:py-2 text-sm font-medium text-text-secondary"
						:aria-sort="sortApplies ? createdAriaSort : undefined"
					>
						<UiTooltip
							:text="
								sortApplies
									? undefined
									: t('dashboard.audience.contacts.index.table.createdSortSearchHint')
							"
						>
							<button
								type="button"
								class="flex items-center gap-1 py-4 -my-4 density-compact:py-2 density-compact:-my-2 px-1 -mx-1 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
								:class="
									sortApplies ? 'hover:text-text-primary' : 'text-text-tertiary cursor-not-allowed'
								"
								:aria-disabled="sortApplies ? undefined : 'true'"
								aria-describedby="contacts-created-sort-hint"
								@click="sortApplies && emit('toggle-sort')"
							>
								{{ t('dashboard.audience.contacts.index.table.created') }}
								<Icon
									v-if="sortApplies && createdSortIcon"
									:name="createdSortIcon"
									class="w-4 h-4"
								/>
							</button>
						</UiTooltip>
						<!-- Hidden, so it describes the button without joining the header's name. -->
						<span id="contacts-created-sort-hint" hidden>
							{{
								sortApplies
									? t('dashboard.audience.contacts.index.table.createdSortHint')
									: t('dashboard.audience.contacts.index.table.createdSortSearchHint')
							}}
						</span>
					</th>
				</tr>
			</thead>
			<tbody>
				<!-- One component per row with a boolean `selected`: a checkbox click
				     re-renders the row it flips, and the menu is built on open. -->
				<ContactsContactRow
					v-for="contact in contacts"
					:key="contact._id"
					:contact="contact"
					:to="contactPath(contact._id)"
					:selected="selectedIds.has(contact._id)"
					:can-manage="canManage"
					@open="emit('open', contact._id)"
					@toggle-select="emit('toggle-select', contact._id)"
				/>
			</tbody>
		</table>
	</div>
</template>
