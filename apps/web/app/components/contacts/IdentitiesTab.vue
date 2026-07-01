<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	contactId: Id<'contacts'>;
}>();

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
		emit('toast', 'Identity added');
	} catch {
		emit('toast', 'Failed to add identity');
	}
};

const onRemove = async (id: Id<'contactIdentities'>) => {
	try {
		await handleRemoveIdentity(id);
		emit('toast', 'Identity removed');
	} catch {
		emit('toast', 'Failed to remove identity');
	}
};

const onVerify = async (id: Id<'contactIdentities'>) => {
	try {
		await handleVerifyIdentity(id);
		emit('toast', 'Identity verified');
	} catch {
		emit('toast', 'Failed to verify identity');
	}
};

const onMerge = async (sourceId: Id<'contacts'>) => {
	try {
		await handleMergeContacts(sourceId);
		emit('toast', 'Contacts merged');
	} catch {
		emit('toast', 'Failed to merge contacts');
	}
};
</script>

<template>
	<div class="space-y-6">
		<!-- Identities Card -->
		<div class="card">
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-medium text-text-primary">Channel Identities</h2>
				<button class="btn btn-secondary btn-sm gap-1" @click="showAddForm = !showAddForm">
					<Icon :name="showAddForm ? 'lucide:x' : 'lucide:plus'" class="w-3 h-3" />
					{{ showAddForm ? 'Cancel' : 'Add Identity' }}
				</button>
			</div>

			<!-- Add Form -->
			<div v-if="showAddForm" class="mb-6 p-4 bg-bg-surface rounded-lg space-y-3">
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
					<div>
						<label for="addform-channel" class="label">Channel</label>
						<select id="addform-channel" v-model="addForm.channel" class="input w-full">
							<option v-for="ch in channelOptions" :key="ch.value" :value="ch.value">
								{{ ch.label }}
							</option>
						</select>
					</div>
					<div>
						<label for="addform-identifier" class="label">Identifier</label>
						<input id="addform-identifier"
							v-model="addForm.identifier"
							type="text"
							class="input w-full"
							:placeholder="addForm.channel === 'email' ? 'email@example.com' : addForm.channel === 'phone' ? '+1234567890' : 'Handle or ID'"
						/>
					</div>
				</div>
				<div class="flex items-center gap-4">
					<label class="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
						<input v-model="addForm.isPrimary" type="checkbox" class="rounded border-border-subtle" />
						Set as primary
					</label>
					<button
						class="btn btn-primary btn-sm"
						:disabled="!addForm.identifier.trim() || isAdding"
						@click="onAdd"
					>
						{{ isAdding ? 'Adding...' : 'Add' }}
					</button>
				</div>
			</div>

			<!-- Loading -->
			<div v-if="identitiesLoading" class="py-6 text-center">
				<UiSpinner size="md" class="mx-auto" />
			</div>

			<!-- Empty -->
			<div v-else-if="!identities || identities.length === 0" class="py-6 text-center">
				<p class="text-text-tertiary text-sm">No identities linked yet.</p>
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
							<span v-if="identity.isPrimary" class="text-xs px-1.5 py-0.5 rounded bg-brand-subtle text-brand">
								Primary
							</span>
							<span v-if="identity.verifiedAt" class="text-xs text-success flex items-center gap-0.5">
								<Icon name="lucide:check-circle" class="w-3 h-3" />
								Verified
							</span>
						</div>
						<p class="text-xs text-text-tertiary">{{ getChannelLabel(identity.channel) }}</p>
					</div>
					<div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
						<button
							v-if="!identity.verifiedAt"
							class="p-1.5 rounded text-text-tertiary hover:text-success hover:bg-success-subtle transition-colors"
							title="Mark as verified"
							@click="onVerify(identity._id)"
						>
							<Icon name="lucide:check-circle" class="w-4 h-4" />
						</button>
						<button
							class="p-1.5 rounded text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors"
							title="Remove identity"
							@click="onRemove(identity._id)"
						>
							<Icon name="lucide:trash-2" class="w-4 h-4" />
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Merge Suggestions -->
		<div
			v-if="mergeSuggestions && mergeSuggestions.length > 0"
			class="card border-warning/20"
		>
			<div class="flex items-center gap-2 mb-4">
				<Icon name="lucide:git-merge" class="w-5 h-5 text-warning" />
				<h2 class="text-lg font-medium text-text-primary">Merge Suggestions</h2>
			</div>
			<p class="text-sm text-text-secondary mb-4">
				These contacts share identifiers and may be the same person.
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
							Matching: {{ suggestion.matchedIdentities.map((i) => `${i.channel}: ${i.identifier}`).join(', ') }}
						</p>
					</div>
					<button
						class="btn btn-secondary btn-sm gap-1"
						@click="onMerge(suggestion.contact._id)"
					>
						<Icon name="lucide:git-merge" class="w-3 h-3" />
						Merge
					</button>
				</div>
			</div>
		</div>
	</div>
</template>
