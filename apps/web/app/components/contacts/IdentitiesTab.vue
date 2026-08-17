<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

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
	handleRemoveIdentity,
	handleVerifyIdentity,
	handleMergeContacts,
	getChannelIcon,
	getChannelLabel,
} = useContactIdentities(contactIdRef);

const emit = defineEmits<{
	toast: [message: string];
}>();

const onAdd = async () => {
	try {
		await handleAddIdentity();
		emit('toast', t('components.contacts.identitiesTab.toasts.added'));
	} catch {
		emit('toast', t('components.contacts.identitiesTab.toasts.addFailed'));
	}
};

const onRemove = async (id: Id<'contactIdentities'>) => {
	try {
		await handleRemoveIdentity(id);
		emit('toast', t('components.contacts.identitiesTab.toasts.removed'));
	} catch {
		emit('toast', t('components.contacts.identitiesTab.toasts.removeFailed'));
	}
};

const onVerify = async (id: Id<'contactIdentities'>) => {
	try {
		await handleVerifyIdentity(id);
		emit('toast', t('components.contacts.identitiesTab.toasts.verified'));
	} catch {
		emit('toast', t('components.contacts.identitiesTab.toasts.verifyFailed'));
	}
};

const onMerge = async (sourceId: Id<'contacts'>) => {
	try {
		await handleMergeContacts(sourceId);
		emit('toast', t('components.contacts.identitiesTab.toasts.merged'));
	} catch {
		emit('toast', t('components.contacts.identitiesTab.toasts.mergeFailed'));
	}
};

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
					<Icon :name="showAddForm ? 'lucide:x' : 'lucide:plus'" class="w-3 h-3" />
					{{ showAddForm ? t('common.cancel') : t('components.contacts.identitiesTab.addIdentity') }}
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
					<label class="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
						<input
							v-model="addForm.isPrimary"
							type="checkbox"
							class="rounded border-border-subtle"
						/>
						{{ t('components.contacts.identitiesTab.setPrimary') }}
					</label>
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
					<Icon :name="getChannelIcon(identity.channel)" class="w-5 h-5 text-brand flex-shrink-0" />
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<p class="text-text-primary text-sm font-medium truncate">
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
								<Icon name="lucide:check-circle" class="w-3 h-3" />
								{{ t('components.contacts.identitiesTab.verified') }}
							</span>
						</div>
						<p class="text-xs text-text-tertiary">{{ t(getChannelLabel(identity.channel)) }}</p>
					</div>
					<div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
						<button
							v-if="!identity.verifiedAt"
							class="p-1.5 rounded text-text-tertiary hover:text-success hover:bg-success-subtle transition-colors"
							:title="t('components.contacts.identitiesTab.markVerified')"
							@click="onVerify(identity._id)"
						>
							<Icon name="lucide:check-circle" class="w-4 h-4" />
						</button>
						<button
							class="p-1.5 rounded text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors"
							:title="t('components.contacts.identitiesTab.removeIdentity')"
							@click="onRemove(identity._id)"
						>
							<Icon name="lucide:trash-2" class="w-4 h-4" />
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Merge Suggestions -->
		<div v-if="mergeSuggestions && mergeSuggestions.length > 0" class="card border-warning/20">
			<div class="flex items-center gap-2 mb-4">
				<Icon name="lucide:git-merge" class="w-5 h-5 text-warning" />
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
									identifiers: suggestion.matchedIdentities
										.map((i) => `${i.channel}: ${i.identifier}`)
										.join(', '),
								})
							}}
						</p>
					</div>
					<UiButton
						variant="secondary"
						size="sm"
						class="gap-1"
						@click="onMerge(suggestion.contact._id)"
					>
						<Icon name="lucide:git-merge" class="w-3 h-3" />
						{{ t('components.contacts.identitiesTab.merge') }}
					</UiButton>
				</div>
			</div>
		</div>
	</div>
</template>
