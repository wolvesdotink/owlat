<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { isAdmin } = usePermissions();
const { showToast: showNotification } = useToast();
const sunsetPage = { numItems: 100, cursor: null } as const;

const { data: policies } = useConvexQuery(api.contacts.sunset.getSunsetPolicies, () =>
	isAdmin.value ? {} : 'skip'
);
const { data: reengagementContacts } = useConvexQuery(api.contacts.sunset.listSunsetStage, () =>
	isAdmin.value ? { stage: 'reengagement' as const, paginationOpts: sunsetPage } : 'skip'
);
const { data: suppressedContacts } = useConvexQuery(api.contacts.sunset.listSunsetStage, () =>
	isAdmin.value ? { stage: 'suppressed' as const, paginationOpts: sunsetPage } : 'skip'
);

const policyForm = reactive({
	isEnabled: true,
	reengageAfterDays: 180,
	suppressAfterDays: 270,
});
watch(
	policies,
	(value) => {
		if (!value) return;
		policyForm.isEnabled = value.global.isEnabled;
		policyForm.reengageAfterDays = value.global.reengageAfterDays;
		policyForm.suppressAfterDays = value.global.suppressAfterDays;
	},
	{ immediate: true }
);

const { run: setPolicy, isLoading: isSaving } = useBackendOperation(
	api.contacts.sunset.setSunsetPolicy,
	{ label: 'Save sunset policy' }
);
const { run: setExemption } = useBackendOperation(api.contacts.sunset.setSunsetContactExemption, {
	label: 'Change sunset exemption',
});
const { run: restoreContact } = useBackendOperation(api.contacts.sunset.restoreSunsetContact, {
	label: 'Restore sunset contact',
});

const savePolicy = async () => {
	const saved = await setPolicy({ ...policyForm });
	if (saved !== undefined) showNotification('Sunset policy saved');
};

const toggleExemption = async (contactId: Id<'contacts'>, exempt: boolean) => {
	const changed = await setExemption({ contactId, exempt });
	if (changed !== undefined) showNotification(exempt ? 'Contact exempted' : 'Exemption removed');
};

const restore = async (contactId: Id<'contacts'>) => {
	const result = await restoreContact({ contactId });
	if (result?.outcome === 'restored') showNotification('Contact restored and exempted');
};
</script>

<template>
	<div v-if="isAdmin && policies" class="card p-6 space-y-6">
		<div>
			<h2 class="font-medium text-text-primary">Automatic list sunsetting</h2>
			<p class="mt-1 text-sm text-text-secondary">
				Move quiet contacts to re-engagement, then suppress them after a longer window.
			</p>
		</div>

		<div class="grid gap-4 md:grid-cols-[auto_1fr_1fr_auto] md:items-end">
			<label class="flex items-center gap-2 pb-2 text-sm text-text-secondary">
				<input v-model="policyForm.isEnabled" type="checkbox" />
				Enabled
			</label>
			<UiInput
				v-model.number="policyForm.reengageAfterDays"
				type="number"
				label="Re-engage after days"
				:min="30"
			/>
			<UiInput
				v-model.number="policyForm.suppressAfterDays"
				type="number"
				label="Suppress after days"
				:min="policyForm.reengageAfterDays"
			/>
			<UiButton :loading="isSaving" @click="savePolicy">Save</UiButton>
		</div>

		<div class="grid gap-6 lg:grid-cols-2">
			<div>
				<h3 class="text-sm font-medium text-text-primary">Re-engagement track</h3>
				<p v-if="!reengagementContacts?.page.length" class="mt-2 text-sm text-text-tertiary">
					No contacts are currently on this track.
				</p>
				<ul v-else class="mt-2 divide-y divide-border-subtle">
					<li
						v-for="contact in reengagementContacts.page"
						:key="contact.contactId"
						class="flex items-center justify-between gap-3 py-2"
					>
						<span class="truncate text-sm text-text-secondary">{{
							contact.email ?? 'No email'
						}}</span>
						<UiButton
							variant="ghost"
							@click="toggleExemption(contact.contactId, !contact.isExempt)"
						>
							{{ contact.isExempt ? 'Remove exemption' : 'Exempt' }}
						</UiButton>
					</li>
				</ul>
			</div>

			<div>
				<h3 class="text-sm font-medium text-text-primary">Auto-suppressed contacts</h3>
				<p v-if="!suppressedContacts?.page.length" class="mt-2 text-sm text-text-tertiary">
					No contacts were auto-suppressed.
				</p>
				<ul v-else class="mt-2 divide-y divide-border-subtle">
					<li
						v-for="contact in suppressedContacts.page"
						:key="contact.contactId"
						class="flex items-center justify-between gap-3 py-2"
					>
						<span class="truncate text-sm text-text-secondary">{{
							contact.email ?? 'No email'
						}}</span>
						<UiButton variant="ghost" @click="restore(contact.contactId)">Restore</UiButton>
					</li>
				</ul>
			</div>
		</div>
	</div>
</template>
