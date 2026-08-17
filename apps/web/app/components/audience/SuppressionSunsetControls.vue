<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();
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
	{ label: () => t('components.audience.suppressionSunsetControls.savePolicyOperation') }
);
const { run: setExemption } = useBackendOperation(api.contacts.sunset.setSunsetContactExemption, {
	label: () => t('components.audience.suppressionSunsetControls.setExemptionOperation'),
});
const { run: restoreContact } = useBackendOperation(api.contacts.sunset.restoreSunsetContact, {
	label: () => t('components.audience.suppressionSunsetControls.restoreOperation'),
});

const savePolicy = async () => {
	const saved = await setPolicy({ ...policyForm });
	if (saved !== undefined)
		showNotification(t('components.audience.suppressionSunsetControls.policySavedToast'));
};

const toggleExemption = async (contactId: Id<'contacts'>, exempt: boolean) => {
	const changed = await setExemption({ contactId, exempt });
	if (changed !== undefined)
		showNotification(
			exempt
				? t('components.audience.suppressionSunsetControls.exemptedToast')
				: t('components.audience.suppressionSunsetControls.exemptionRemovedToast')
		);
};

const restore = async (contactId: Id<'contacts'>) => {
	const result = await restoreContact({ contactId });
	if (result?.outcome === 'restored')
		showNotification(t('components.audience.suppressionSunsetControls.restoredToast'));
};
</script>

<template>
	<div v-if="isAdmin && policies" class="card p-6 space-y-6">
		<div>
			<h2 class="font-medium text-text-primary">
				{{ t('components.audience.suppressionSunsetControls.title') }}
			</h2>
			<p class="mt-1 text-sm text-text-secondary">
				{{ t('components.audience.suppressionSunsetControls.description') }}
			</p>
		</div>

		<div class="grid gap-4 md:grid-cols-[auto_1fr_1fr_auto] md:items-end">
			<label class="flex items-center gap-2 pb-2 text-sm text-text-secondary">
				<input v-model="policyForm.isEnabled" type="checkbox" />
				{{ t('common.enabled') }}
			</label>
			<UiInput
				v-model.number="policyForm.reengageAfterDays"
				type="number"
				:label="t('components.audience.suppressionSunsetControls.reengageAfterDays')"
				:min="30"
			/>
			<UiInput
				v-model.number="policyForm.suppressAfterDays"
				type="number"
				:label="t('components.audience.suppressionSunsetControls.suppressAfterDays')"
				:min="policyForm.reengageAfterDays"
			/>
			<UiButton :loading="isSaving" @click="savePolicy">{{ t('common.save') }}</UiButton>
		</div>

		<div class="grid gap-6 lg:grid-cols-2">
			<div>
				<h3 class="text-sm font-medium text-text-primary">
					{{ t('components.audience.suppressionSunsetControls.reengagementTrack') }}
				</h3>
				<p v-if="!reengagementContacts?.page.length" class="mt-2 text-sm text-text-tertiary">
					{{ t('components.audience.suppressionSunsetControls.reengagementEmpty') }}
				</p>
				<ul v-else class="mt-2 divide-y divide-border-subtle">
					<li
						v-for="contact in reengagementContacts.page"
						:key="contact.contactId"
						class="flex items-center justify-between gap-3 py-2"
					>
						<span class="truncate text-sm text-text-secondary">{{
							contact.email ?? t('components.audience.suppressionSunsetControls.noEmail')
						}}</span>
						<UiButton
							variant="ghost"
							@click="toggleExemption(contact.contactId, !contact.isExempt)"
						>
							{{
								contact.isExempt
									? t('components.audience.suppressionSunsetControls.removeExemption')
									: t('components.audience.suppressionSunsetControls.exempt')
							}}
						</UiButton>
					</li>
				</ul>
			</div>

			<div>
				<h3 class="text-sm font-medium text-text-primary">
					{{ t('components.audience.suppressionSunsetControls.autoSuppressed') }}
				</h3>
				<p v-if="!suppressedContacts?.page.length" class="mt-2 text-sm text-text-tertiary">
					{{ t('components.audience.suppressionSunsetControls.autoSuppressedEmpty') }}
				</p>
				<ul v-else class="mt-2 divide-y divide-border-subtle">
					<li
						v-for="contact in suppressedContacts.page"
						:key="contact.contactId"
						class="flex items-center justify-between gap-3 py-2"
					>
						<span class="truncate text-sm text-text-secondary">{{
							contact.email ?? t('components.audience.suppressionSunsetControls.noEmail')
						}}</span>
						<UiButton variant="ghost" @click="restore(contact.contactId)">{{
							t('components.audience.suppressionSunsetControls.restore')
						}}</UiButton>
					</li>
				</ul>
			</div>
		</div>
	</div>
</template>
