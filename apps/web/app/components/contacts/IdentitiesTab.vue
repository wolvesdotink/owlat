<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { CircleCheckIcon, CloseIcon, GitMergeIcon, PlusIcon, TrashIcon } from '@coolicons/vue';

const props = defineProps<{
	contactId: Id<'contacts'>;
}>();

const { t } = useI18n();

const contactIdRef = computed(() => props.contactId);

const {
	identities,
	identitiesLoading,
	mergeSuggestions,
	showAddForm,
	addForm,
	isAdding,
	channelOptions,
	handleAddIdentity,
	getChannelIcon,
	getChannelLabel,
} = useContactIdentities(contactIdRef);

const emit = defineEmits<{
	toast: [message: string];
}>();

// The operation helper presents a failure itself and resolves with `ok: false`
// instead of throwing, so a success toast must wait for `ok`.
const { run: removeIdentity } = useBackendOperation(api.contacts.identities.removeIdentity, {
	label: () => t('shared.useContactIdentities.removeIdentityOperation'),
});
const { run: verifyIdentity } = useBackendOperation(api.contacts.identities.verifyIdentity, {
	label: () => t('shared.useContactIdentities.verifyIdentityOperation'),
});
const { run: mergeContacts, isLoading: isMerging } = useBackendOperation(
	api.contacts.identities.mergeContacts,
	{ label: () => t('shared.useContactIdentities.mergeContactsOperation') }
);

const onAdd = async () => {
	await handleAddIdentity();
	// The composable closes the form only after a successful write.
	if (!showAddForm.value) emit('toast', t('components.contacts.identitiesTab.toasts.added'));
};

const onRemove = async (identityId: Id<'contactIdentities'>) => {
	const result = await removeIdentity({ identityId });
	if (result.ok) emit('toast', t('components.contacts.identitiesTab.toasts.removed'));
};

const onVerify = async (identityId: Id<'contactIdentities'>) => {
	const result = await verifyIdentity({ identityId });
	if (result.ok) emit('toast', t('components.contacts.identitiesTab.toasts.verified'));
};

// A merge moves the other contact's records here and deletes it, with no undo,
// so it asks first and names the contact that goes away.
const pendingMerge = ref<{ id: Id<'contacts'>; label: string } | null>(null);
const isMergeConfirmOpen = computed({
	get: () => pendingMerge.value !== null,
	set: (open) => {
		if (!open) pendingMerge.value = null;
	},
});

const confirmMerge = async () => {
	const target = pendingMerge.value;
	if (!target) return;
	const result = await mergeContacts({
		targetContactId: props.contactId,
		sourceContactId: target.id,
	});
	pendingMerge.value = null;
	if (result.ok) emit('toast', t('components.contacts.identitiesTab.toasts.merged'));
};

const describeMatches = (matched: Array<{ channel: string; identifier: string }>) =>
	matched.map((i) => `${t(getChannelLabel(i.channel))}: ${i.identifier}`).join(', ');

const identifierPlaceholder = computed(() => {
	if (addForm.channel === 'email')
		return t('components.contacts.identitiesTab.identifierPlaceholder.email');
	if (addForm.channel === 'phone')
		return t('components.contacts.identitiesTab.identifierPlaceholder.phone');
	return t('components.contacts.identitiesTab.identifierPlaceholder.other');
});
</script>

<template>
	<div class="space-y-6">
		<!-- Identities Card -->
		<div class="card">
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-medium text-text-primary">
					{{ t('components.contacts.identitiesTab.title') }}
				</h2>
				<UiButton variant="secondary" size="sm" class="gap-1" @click="showAddForm = !showAddForm">
					<component :is="showAddForm ? CloseIcon : PlusIcon" class="w-3 h-3" />
					{{
						showAddForm ? t('common.cancel') : t('components.contacts.identitiesTab.addIdentity')
					}}
				</UiButton>
			</div>

			<!-- Add Form -->
			<div v-if="showAddForm" class="mb-6 p-4 bg-bg-surface rounded-lg space-y-3">
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
					<div>
						<label for="addform-channel" class="label">{{
							t('components.contacts.identitiesTab.channel')
						}}</label>
						<select id="addform-channel" v-model="addForm.channel" class="input w-full">
							<option v-for="ch in channelOptions" :key="ch.value" :value="ch.value">
								{{ t(ch.label) }}
							</option>
						</select>
					</div>
					<div>
						<label for="addform-identifier" class="label">{{
							t('components.contacts.identitiesTab.identifier')
						}}</label>
						<input
							id="addform-identifier"
							v-model="addForm.identifier"
							type="text"
							class="input w-full"
							:placeholder="identifierPlaceholder"
						/>
					</div>
				</div>
				<div class="flex items-center gap-4">
					<UiCheckbox
						v-model="addForm.isPrimary"
						:label="t('components.contacts.identitiesTab.setPrimary')"
					/>
					<UiButton size="sm" :disabled="!addForm.identifier.trim() || isAdding" @click="onAdd">
						{{ isAdding ? t('components.contacts.identitiesTab.adding') : t('common.add') }}
					</UiButton>
				</div>
			</div>

			<!-- Loading -->
			<div v-if="identitiesLoading" class="py-6 text-center">
				<UiSpinner size="md" class="mx-auto" />
			</div>

			<!-- Empty -->
			<div v-else-if="!identities || identities.length === 0" class="py-6 text-center">
				<p class="text-text-tertiary text-sm">
					{{ t('components.contacts.identitiesTab.empty') }}
				</p>
			</div>

			<!-- Identity List -->
			<div v-else class="space-y-2">
				<div
					v-for="identity in identities"
					:key="identity._id"
					class="group flex items-center gap-3 p-3 rounded-lg bg-bg-surface"
				>
					<component
						:is="getChannelIcon(identity.channel)"
						class="w-5 h-5 text-brand flex-shrink-0"
					/>
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<p
								class="text-text-primary text-sm font-medium truncate"
								:title="identity.identifier"
							>
								{{ identity.identifier }}
							</p>
							<span
								v-if="identity.isPrimary"
								class="text-xs px-1.5 py-0.5 rounded bg-brand-subtle text-brand"
							>
								{{ t('components.contacts.identitiesTab.primary') }}
							</span>
							<span
								v-if="identity.verifiedAt"
								class="text-xs text-success flex items-center gap-0.5"
							>
								<CircleCheckIcon class="w-3 h-3" />
								{{ t('components.contacts.identitiesTab.verified') }}
							</span>
						</div>
						<p class="text-xs text-text-tertiary">{{ t(getChannelLabel(identity.channel)) }}</p>
					</div>
					<div
						class="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity"
					>
						<UiTooltip
							v-if="!identity.verifiedAt"
							:text="t('components.contacts.identitiesTab.markVerified')"
						>
							<button
								type="button"
								class="inline-flex items-center justify-center p-1.5 pointer-coarse:size-11 rounded text-text-tertiary hover:text-success hover:bg-success-subtle transition-colors"
								:aria-label="t('components.contacts.identitiesTab.markVerified')"
								@click="onVerify(identity._id)"
							>
								<CircleCheckIcon class="w-4 h-4" />
							</button>
						</UiTooltip>
						<UiTooltip :text="t('components.contacts.identitiesTab.removeIdentity')">
							<button
								type="button"
								class="inline-flex items-center justify-center p-1.5 pointer-coarse:size-11 rounded text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors"
								:aria-label="t('components.contacts.identitiesTab.removeIdentity')"
								@click="onRemove(identity._id)"
							>
								<TrashIcon class="w-4 h-4" />
							</button>
						</UiTooltip>
					</div>
				</div>
			</div>
		</div>

		<!-- Merge Suggestions -->
		<div v-if="mergeSuggestions && mergeSuggestions.length > 0" class="card border-warning/20">
			<div class="flex items-center gap-2 mb-4">
				<GitMergeIcon class="w-5 h-5 text-warning" />
				<h2 class="text-lg font-medium text-text-primary">
					{{ t('components.contacts.identitiesTab.mergeSuggestions') }}
				</h2>
			</div>
			<p class="text-sm text-text-secondary mb-4">
				{{ t('components.contacts.identitiesTab.mergeSuggestionsIntro') }}
			</p>
			<div class="space-y-3">
				<div
					v-for="suggestion in mergeSuggestions"
					:key="suggestion.contact._id"
					class="flex items-center justify-between p-3 bg-bg-surface rounded-lg"
				>
					<div>
						<p class="text-text-primary text-sm font-medium">
							{{ suggestion.contact.email }}
						</p>
						<p class="text-xs text-text-tertiary">
							{{
								t('components.contacts.identitiesTab.matching', {
									identifiers: describeMatches(suggestion.matchedIdentities),
								})
							}}
						</p>
					</div>
					<UiButton
						variant="secondary"
						size="sm"
						class="gap-1"
						:disabled="isMerging"
						@click="
							pendingMerge = {
								id: suggestion.contact._id,
								label: suggestion.contact.email || describeMatches(suggestion.matchedIdentities),
							}
						"
					>
						<GitMergeIcon class="w-3 h-3" />
						{{ t('components.contacts.identitiesTab.merge') }}
					</UiButton>
				</div>
			</div>
		</div>

		<UiConfirmationDialog
			v-model:open="isMergeConfirmOpen"
			variant="warning"
			:title="t('components.contacts.identitiesTab.mergeConfirm.title')"
			:description="
				t('components.contacts.identitiesTab.mergeConfirm.body', {
					contact: pendingMerge?.label ?? '',
				})
			"
			:confirm-text="t('components.contacts.identitiesTab.merge')"
			:is-loading="isMerging"
			@confirm="confirmMerge"
		/>
	</div>
</template>
