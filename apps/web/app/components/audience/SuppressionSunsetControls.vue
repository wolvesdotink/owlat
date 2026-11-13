<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	SUNSET_MIN_WINDOW_DAYS,
	SUNSET_REENGAGE_AFTER_DAYS,
	SUNSET_SUPPRESS_AFTER_DAYS,
} from '@owlat/shared/sunsetPolicy';

const { t } = useI18n();
const { isAdmin } = usePermissions();
const { showToast: showNotification } = useToast();
// Each track reads one growing page from its start; "Show more" widens it, so a
// contact past the first hundred can still be restored or exempted here.
const TRACK_PAGE = 100;
const reengagementLimit = ref(TRACK_PAGE);
const suppressedLimit = ref(TRACK_PAGE);

const {
	data: policies,
	error: policiesError,
	refetch: refetchPolicies,
} = useConvexQuery(api.contacts.sunset.getSunsetPolicies, () => (isAdmin.value ? {} : 'skip'));
const { data: reengagementContacts, error: reengagementError } = useConvexQuery(
	api.contacts.sunset.listSunsetStage,
	() =>
		isAdmin.value
			? {
					stage: 'reengagement' as const,
					paginationOpts: { numItems: reengagementLimit.value, cursor: null },
				}
			: 'skip'
);
const { data: suppressedContacts, error: suppressedError } = useConvexQuery(
	api.contacts.sunset.listSunsetStage,
	() =>
		isAdmin.value
			? {
					stage: 'suppressed' as const,
					paginationOpts: { numItems: suppressedLimit.value, cursor: null },
				}
			: 'skip'
);

const policyForm = reactive({
	isEnabled: true,
	reengageAfterDays: SUNSET_REENGAGE_AFTER_DAYS,
	suppressAfterDays: SUNSET_SUPPRESS_AFTER_DAYS,
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

// Nothing is stored until Save, so Save is offered only for a change and the
// card says when one is waiting.
const isDirty = computed(() => {
	const saved = policies.value?.global;
	if (!saved) return false;
	return (
		saved.isEnabled !== policyForm.isEnabled ||
		saved.reengageAfterDays !== policyForm.reengageAfterDays ||
		saved.suppressAfterDays !== policyForm.suppressAfterDays
	);
});

// The row whose Exempt or Restore is in flight.
const pendingContactId = ref<Id<'contacts'> | null>(null);

const savePolicy = async () => {
	const saved = await setPolicy({ ...policyForm });
	if (saved.ok)
		showNotification(t('components.audience.suppressionSunsetControls.policySavedToast'));
};

const toggleExemption = async (contactId: Id<'contacts'>, exempt: boolean) => {
	pendingContactId.value = contactId;
	const changed = await setExemption({ contactId, exempt });
	pendingContactId.value = null;
	if (changed.ok)
		showNotification(
			exempt
				? t('components.audience.suppressionSunsetControls.exemptedToast')
				: t('components.audience.suppressionSunsetControls.exemptionRemovedToast')
		);
};

const restore = async (contactId: Id<'contacts'>) => {
	pendingContactId.value = contactId;
	const result = await restoreContact({ contactId });
	pendingContactId.value = null;
	if (!result.ok) return;
	// Any other outcome means the contact left the track before the click landed.
	showNotification(
		result.result?.outcome === 'restored'
			? t('components.audience.suppressionSunsetControls.restoredToast')
			: t('components.audience.suppressionSunsetControls.restoreNotNeededToast')
	);
};
</script>

<template>
	<UiQueryBoundary
		v-if="isAdmin && policiesError"
		:error="policiesError"
		@retry="refetchPolicies"
	/>
	<div v-else-if="isAdmin && policies" class="card p-6 space-y-6">
		<div>
			<h2 class="font-medium text-text-primary">
				{{ t('components.audience.suppressionSunsetControls.title') }}
			</h2>
			<p class="mt-1 text-sm text-text-secondary">
				{{ t('components.audience.suppressionSunsetControls.description') }}
			</p>
		</div>

		<div class="grid gap-4 md:grid-cols-[auto_1fr_1fr_auto] md:items-end">
			<div class="flex items-center gap-2 pb-2">
				<UiSwitch id="suppression-sunset-enabled" v-model="policyForm.isEnabled" />
				<label for="suppression-sunset-enabled" class="text-sm text-text-secondary">
					{{ t('components.audience.suppressionSunsetControls.enabledLabel') }}
				</label>
			</div>
			<UiInput
				v-model.number="policyForm.reengageAfterDays"
				type="number"
				:label="t('components.audience.suppressionSunsetControls.reengageAfterDays')"
				:min="SUNSET_MIN_WINDOW_DAYS"
			/>
			<UiInput
				v-model.number="policyForm.suppressAfterDays"
				type="number"
				:label="t('components.audience.suppressionSunsetControls.suppressAfterDays')"
				:min="policyForm.reengageAfterDays"
			/>
			<div class="flex items-center gap-3">
				<span v-if="isDirty" class="text-sm text-text-tertiary whitespace-nowrap" role="status">
					{{ t('components.audience.suppressionSunsetControls.unsaved') }}
				</span>
				<UiButton :loading="isSaving" :disabled="!isDirty" @click="savePolicy">{{
					t('common.save')
				}}</UiButton>
			</div>
		</div>

		<!-- min-w-0 on the columns: a grid item is otherwise as wide as its
		     longest address, and on a phone that pushed the page sideways. -->
		<div class="grid gap-6 lg:grid-cols-2">
			<div class="min-w-0">
				<h3 class="text-sm font-medium text-text-primary">
					{{ t('components.audience.suppressionSunsetControls.reengagementTrack') }}
				</h3>
				<p v-if="reengagementError" class="mt-2 text-sm text-error" role="alert">
					{{ t('components.audience.suppressionSunsetControls.trackError') }}
				</p>
				<div v-else-if="reengagementContacts === undefined" class="mt-3">
					<UiSpinner size="xs" />
				</div>
				<p v-else-if="!reengagementContacts.page.length" class="mt-2 text-sm text-text-tertiary">
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
							class="shrink-0 whitespace-nowrap"
							:loading="pendingContactId === contact.contactId"
							:disabled="pendingContactId !== null && pendingContactId !== contact.contactId"
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
				<UiButton
					v-if="reengagementContacts && !reengagementContacts.isDone"
					variant="ghost"
					size="sm"
					class="mt-2"
					@click="reengagementLimit += TRACK_PAGE"
				>
					{{ t('components.audience.suppressionSunsetControls.showMore') }}
				</UiButton>
			</div>

			<div class="min-w-0">
				<h3 class="text-sm font-medium text-text-primary">
					{{ t('components.audience.suppressionSunsetControls.autoSuppressed') }}
				</h3>
				<p v-if="suppressedError" class="mt-2 text-sm text-error" role="alert">
					{{ t('components.audience.suppressionSunsetControls.trackError') }}
				</p>
				<div v-else-if="suppressedContacts === undefined" class="mt-3">
					<UiSpinner size="xs" />
				</div>
				<p v-else-if="!suppressedContacts.page.length" class="mt-2 text-sm text-text-tertiary">
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
						<UiButton
							variant="ghost"
							class="shrink-0 whitespace-nowrap"
							:loading="pendingContactId === contact.contactId"
							:disabled="pendingContactId !== null && pendingContactId !== contact.contactId"
							@click="restore(contact.contactId)"
							>{{ t('components.audience.suppressionSunsetControls.restore') }}</UiButton
						>
					</li>
				</ul>
				<UiButton
					v-if="suppressedContacts && !suppressedContacts.isDone"
					variant="ghost"
					size="sm"
					class="mt-2"
					@click="suppressedLimit += TRACK_PAGE"
				>
					{{ t('components.audience.suppressionSunsetControls.showMore') }}
				</UiButton>
			</div>
		</div>
	</div>
</template>
