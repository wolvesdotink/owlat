<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	contactId: Id<'contacts'>;
}>();

const contactIdRef = computed(() => props.contactId);

const {
	relationships,
	relationshipsLoading,
	showAddForm,
	addForm,
	isAdding,
	relationshipTypes,
	targetSearch,
	targetCandidates,
	contactLabel,
	selectTargetContact,
	clearTargetContact,
	handleAddRelationship,
	handleRemoveRelationship,
	handleUpdateConfidence,
	getRelationshipIcon,
	getDirectionLabel,
} = useContactRelationships(contactIdRef);

const emit = defineEmits<{
	toast: [message: string];
}>();

// Which relationship row currently has its confidence slider open for editing.
const editingConfidenceId = ref<Id<'contactRelationships'> | null>(null);
const editingConfidence = ref(1);

const startEditConfidence = (id: Id<'contactRelationships'>, confidence: number) => {
	editingConfidenceId.value = id;
	editingConfidence.value = confidence;
};

const cancelEditConfidence = () => {
	editingConfidenceId.value = null;
};

const saveConfidence = async (id: Id<'contactRelationships'>) => {
	try {
		await handleUpdateConfidence(id, editingConfidence.value);
		emit('toast', 'Confidence updated');
	} catch {
		emit('toast', 'Failed to update confidence');
	} finally {
		editingConfidenceId.value = null;
	}
};

const onAdd = async () => {
	try {
		await handleAddRelationship();
		emit('toast', 'Relationship added');
	} catch {
		emit('toast', 'Failed to add relationship');
	}
};

const onRemove = async (id: Id<'contactRelationships'>) => {
	try {
		await handleRemoveRelationship(id);
		emit('toast', 'Relationship removed');
	} catch {
		emit('toast', 'Failed to remove relationship');
	}
};
</script>

<template>
	<div class="space-y-6">
		<div class="card">
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-medium text-text-primary">Relationships</h2>
				<button class="btn btn-secondary btn-sm gap-1" @click="showAddForm = !showAddForm">
					<Icon :name="showAddForm ? 'lucide:x' : 'lucide:plus'" class="w-3 h-3" />
					{{ showAddForm ? 'Cancel' : 'Add Relationship' }}
				</button>
			</div>

			<!-- Add Form -->
			<div v-if="showAddForm" class="mb-6 p-4 bg-bg-surface rounded-lg space-y-3">
				<div>
					<label for="addform-tocontact" class="label">Related contact</label>
					<!-- Chosen target shown as a removable chip. -->
					<div
						v-if="addForm.toContactId"
						class="flex items-center justify-between gap-2 input w-full"
					>
						<span class="text-sm text-text-primary truncate">{{ addForm.toContactLabel }}</span>
						<button
							type="button"
							class="flex-shrink-0 text-text-tertiary hover:text-text-primary"
							title="Clear selected contact"
							@click="clearTargetContact"
						>
							<Icon name="lucide:x" class="w-4 h-4" />
						</button>
					</div>
					<!-- Otherwise search and pick a contact by name or email. -->
					<div v-else class="relative">
						<input id="addform-tocontact"
							v-model="targetSearch"
							type="text"
							class="input w-full"
							placeholder="Search contacts by name or email…"
							autocomplete="off"
						/>
						<ul
							v-if="targetSearch && targetCandidates.length > 0"
							class="absolute z-10 mt-1 w-full max-h-56 overflow-auto rounded-lg border border-border-subtle bg-bg-elevated shadow-lg"
						>
							<li v-for="candidate in targetCandidates" :key="candidate._id">
								<button
									type="button"
									class="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-bg-surface transition-colors"
									@click="selectTargetContact(candidate)"
								>
									{{ contactLabel(candidate) }}
									<span
										v-if="(candidate.firstName || candidate.lastName) && candidate.email"
										class="text-text-tertiary"
									> · {{ candidate.email }}</span>
								</button>
							</li>
						</ul>
						<p
							v-else-if="targetSearch && targetCandidates.length === 0"
							class="text-xs text-text-tertiary mt-1"
						>
							No matching contacts.
						</p>
						<p v-else class="text-xs text-text-tertiary mt-1">
							Search for the related contact by name or email.
						</p>
					</div>
				</div>
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
					<div>
						<label for="addform-relationship" class="label">Relationship Type</label>
						<select id="addform-relationship" v-model="addForm.relationship" class="input w-full">
							<option v-for="type in relationshipTypes" :key="type" :value="type">
								{{ type.replace(/_/g, ' ') }}
							</option>
						</select>
					</div>
					<div>
						<label class="label">Confidence</label>
						<div class="flex items-center gap-2">
							<input
								v-model.number="addForm.confidence"
								type="range"
								min="0"
								max="1"
								step="0.1"
								class="flex-1 h-2 bg-bg-elevated rounded-lg appearance-none cursor-pointer accent-brand"
							/>
							<span class="text-sm text-text-secondary font-mono w-12 text-right">
								{{ Math.round(addForm.confidence * 100) }}%
							</span>
						</div>
					</div>
				</div>
				<button
					class="btn btn-primary btn-sm"
					:disabled="!addForm.toContactId || isAdding"
					@click="onAdd"
				>
					{{ isAdding ? 'Adding...' : 'Add Relationship' }}
				</button>
			</div>

			<!-- Loading -->
			<div v-if="relationshipsLoading" class="py-6 text-center">
				<div class="w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin mx-auto" />
			</div>

			<!-- Empty -->
			<div v-else-if="!relationships || relationships.length === 0" class="py-6 text-center">
				<UiIconBox icon="lucide:users" size="lg" variant="surface" rounded="full" class="mb-3 mx-auto" />
				<p class="text-text-tertiary text-sm">No relationships found.</p>
				<p class="text-text-tertiary text-xs mt-1">
					Add a relationship to map how this contact connects to others.
				</p>
			</div>

			<!-- Relationships List -->
			<div v-else class="space-y-2">
				<div
					v-for="rel in relationships"
					:key="rel._id"
					class="group flex items-center gap-3 p-3 rounded-lg bg-bg-surface"
				>
					<div
						class="flex-shrink-0 w-10 h-10 rounded-full bg-bg-elevated flex items-center justify-center"
					>
						<Icon :name="getRelationshipIcon(rel.relationship)" class="w-5 h-5 text-brand" />
					</div>
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<NuxtLink
								v-if="rel.relatedContact"
								:to="`/dashboard/audience/contacts/${rel.relatedContact._id}`"
								class="text-text-primary text-sm font-medium truncate hover:text-brand transition-colors"
							>
								{{ rel.relatedContact.firstName || rel.relatedContact.lastName
									? `${rel.relatedContact.firstName ?? ''} ${rel.relatedContact.lastName ?? ''}`.trim()
									: rel.relatedContact.email
								}}
							</NuxtLink>
							<span v-else class="text-text-tertiary text-sm">Unknown contact</span>
						</div>
						<div class="flex items-center gap-2 mt-0.5">
							<span class="text-xs text-text-tertiary">
								{{ getDirectionLabel(rel.direction) }}
							</span>
							<span class="text-xs px-1.5 py-0.5 rounded bg-bg-elevated text-text-secondary capitalize">
								{{ (('displayRelationship' in rel ? rel.displayRelationship : undefined) || rel.relationship).replace(/_/g, ' ') }}
							</span>
							<!-- Inline confidence editor: percentage is a button that
							     reveals the same slider the Add form uses. -->
							<div v-if="editingConfidenceId === rel._id" class="flex items-center gap-1.5">
								<input
									v-model.number="editingConfidence"
									type="range"
									min="0"
									max="1"
									step="0.1"
									class="w-24 h-2 bg-bg-elevated rounded-lg appearance-none cursor-pointer accent-brand"
									:aria-label="`Confidence for ${rel.relatedContact?.email ?? 'relationship'}`"
								/>
								<span class="text-xs text-text-secondary font-mono w-9 text-right">
									{{ Math.round(editingConfidence * 100) }}%
								</span>
								<button
									type="button"
									class="p-1 rounded text-text-tertiary hover:text-brand hover:bg-bg-elevated transition-colors"
									title="Save confidence"
									@click="saveConfidence(rel._id)"
								>
									<Icon name="lucide:check" class="w-3.5 h-3.5" />
								</button>
								<button
									type="button"
									class="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
									title="Cancel"
									@click="cancelEditConfidence"
								>
									<Icon name="lucide:x" class="w-3.5 h-3.5" />
								</button>
							</div>
							<button
								v-else
								type="button"
								class="text-xs text-text-tertiary font-mono hover:text-brand transition-colors"
								title="Edit confidence"
								@click="startEditConfidence(rel._id, rel.confidence ?? 1)"
							>
								{{ Math.round((rel.confidence ?? 1) * 100) }}%
							</button>
						</div>
					</div>
					<button
						class="p-1.5 rounded text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-error hover:bg-error-subtle transition-all"
						title="Remove relationship"
						@click="onRemove(rel._id)"
					>
						<Icon name="lucide:trash-2" class="w-4 h-4" />
					</button>
				</div>
			</div>
		</div>
	</div>
</template>
