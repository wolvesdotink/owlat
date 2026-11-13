<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { CheckIcon, CloseIcon, PlusIcon, TrashIcon, UsersIcon } from '@coolicons/vue';

const props = defineProps<{
	contactId: Id<'contacts'>;
}>();

const { t, te } = useI18n();

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
	getRelationshipIcon,
	getDirectionLabel,
} = useContactRelationships(contactIdRef);

const emit = defineEmits<{
	toast: [message: string];
}>();

// The operation helper presents a failure itself and resolves with `ok: false`
// instead of throwing, so a success toast must wait for `ok`.
const { run: removeRelationship } = useBackendOperation(api.contacts.relationships.remove, {
	label: () => t('shared.useContactRelationships.removeRelationshipOperation'),
});
const { run: updateConfidence } = useBackendOperation(api.contacts.relationships.updateConfidence, {
	label: () => t('shared.useContactRelationships.updateConfidenceOperation'),
});

const confidenceSliderId = useId();

// Confidence is stored as 0..1 but shown in words: the UI never prints a raw
// confidence percentage.
const confidenceLabel = (confidence: number) => {
	if (confidence >= 0.9) return t('components.contacts.relationshipsTab.confidenceLevels.certain');
	if (confidence >= 0.6) return t('components.contacts.relationshipsTab.confidenceLevels.likely');
	return t('components.contacts.relationshipsTab.confidenceLevels.possible');
};

// Known types read as words in the viewer's language; an unknown stored value
// falls back to its own spelling.
const relationshipLabel = (type: string) => {
	const key = `components.contacts.relationshipsTab.types.${type}`;
	return te(key) ? t(key) : type.replace(/_/g, ' ');
};

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

const saveConfidence = async (relationshipId: Id<'contactRelationships'>) => {
	const confidence = Math.min(1, Math.max(0, editingConfidence.value));
	const result = await updateConfidence({ relationshipId, confidence });
	editingConfidenceId.value = null;
	if (result.ok) emit('toast', t('components.contacts.relationshipsTab.toasts.confidenceUpdated'));
};

const onAdd = async () => {
	await handleAddRelationship();
	// The composable closes the form only after a successful write.
	if (!showAddForm.value) emit('toast', t('components.contacts.relationshipsTab.toasts.added'));
};

const onRemove = async (relationshipId: Id<'contactRelationships'>) => {
	const result = await removeRelationship({ relationshipId });
	if (result.ok) emit('toast', t('components.contacts.relationshipsTab.toasts.removed'));
};
</script>

<template>
	<div class="space-y-6">
		<div class="card">
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-medium text-text-primary">
					{{ t('components.contacts.relationshipsTab.title') }}
				</h2>
				<UiButton variant="secondary" size="sm" class="gap-1" @click="showAddForm = !showAddForm">
					<component :is="showAddForm ? CloseIcon : PlusIcon" class="w-3 h-3" />
					{{
						showAddForm
							? t('common.cancel')
							: t('components.contacts.relationshipsTab.addRelationship')
					}}
				</UiButton>
			</div>

			<!-- Add Form -->
			<div v-if="showAddForm" class="mb-6 p-4 bg-bg-surface rounded-lg space-y-3">
				<div>
					<label for="addform-tocontact" class="label">{{
						t('components.contacts.relationshipsTab.relatedContact')
					}}</label>
					<!-- Chosen target shown as a removable chip. -->
					<div
						v-if="addForm.toContactId"
						class="flex items-center justify-between gap-2 input w-full"
					>
						<span class="text-sm text-text-primary truncate">{{ addForm.toContactLabel }}</span>
						<UiTooltip :text="t('components.contacts.relationshipsTab.clearSelected')">
							<button
								type="button"
								class="flex-shrink-0 text-text-tertiary hover:text-text-primary"
								:aria-label="t('components.contacts.relationshipsTab.clearSelected')"
								@click="clearTargetContact"
							>
								<CloseIcon class="w-4 h-4" />
							</button>
						</UiTooltip>
					</div>
					<!-- Otherwise search and pick a contact by name or email. -->
					<div v-else class="relative">
						<input
							id="addform-tocontact"
							v-model="targetSearch"
							type="text"
							class="input w-full"
							:placeholder="t('components.contacts.relationshipsTab.searchPlaceholder')"
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
									>
										· {{ candidate.email }}</span
									>
								</button>
							</li>
						</ul>
						<p
							v-else-if="targetSearch && targetCandidates.length === 0"
							class="text-xs text-text-tertiary mt-1"
						>
							{{ t('components.contacts.relationshipsTab.noMatches') }}
						</p>
						<p v-else class="text-xs text-text-tertiary mt-1">
							{{ t('components.contacts.relationshipsTab.searchHint') }}
						</p>
					</div>
				</div>
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
					<div>
						<label for="addform-relationship" class="label">{{
							t('components.contacts.relationshipsTab.relationshipType')
						}}</label>
						<select id="addform-relationship" v-model="addForm.relationship" class="input w-full">
							<option v-for="type in relationshipTypes" :key="type" :value="type">
								{{ relationshipLabel(type) }}
							</option>
						</select>
					</div>
					<div>
						<label :for="confidenceSliderId" class="label">{{
							t('components.contacts.relationshipsTab.confidence')
						}}</label>
						<div class="flex items-center gap-2">
							<input
								:id="confidenceSliderId"
								v-model.number="addForm.confidence"
								type="range"
								:aria-valuetext="confidenceLabel(addForm.confidence)"
								min="0"
								max="1"
								step="0.1"
								class="flex-1 h-2 bg-bg-elevated rounded-lg appearance-none cursor-pointer accent-brand"
							/>
							<span class="text-sm text-text-secondary w-20 text-right">
								{{ confidenceLabel(addForm.confidence) }}
							</span>
						</div>
					</div>
				</div>
				<UiButton size="sm" :disabled="!addForm.toContactId || isAdding" @click="onAdd">
					{{
						isAdding
							? t('components.contacts.relationshipsTab.adding')
							: t('components.contacts.relationshipsTab.addRelationship')
					}}
				</UiButton>
			</div>

			<!-- Loading -->
			<div v-if="relationshipsLoading" class="py-6 text-center">
				<UiSpinner size="md" class="mx-auto" />
			</div>

			<!-- Empty -->
			<div v-else-if="!relationships || relationships.length === 0" class="py-6 text-center">
				<UiIconBox
					:icon="UsersIcon"
					size="lg"
					variant="surface"
					rounded="full"
					class="mb-3 mx-auto"
				/>
				<p class="text-text-tertiary text-sm">
					{{ t('components.contacts.relationshipsTab.emptyTitle') }}
				</p>
				<p class="text-text-tertiary text-xs mt-1">
					{{ t('components.contacts.relationshipsTab.emptyBody') }}
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
						<component :is="getRelationshipIcon(rel.relationship)" class="w-5 h-5 text-brand" />
					</div>
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<NuxtLink
								v-if="rel.relatedContact"
								:to="`/dashboard/audience/contacts/${rel.relatedContact._id}`"
								class="text-text-primary text-sm font-medium truncate hover:text-brand transition-colors"
							>
								{{
									rel.relatedContact.firstName || rel.relatedContact.lastName
										? `${rel.relatedContact.firstName ?? ''} ${rel.relatedContact.lastName ?? ''}`.trim()
										: rel.relatedContact.email
								}}
							</NuxtLink>
							<span v-else class="text-text-tertiary text-sm">{{
								t('components.contacts.relationshipsTab.unknownContact')
							}}</span>
						</div>
						<div class="flex items-center gap-2 mt-0.5">
							<span class="text-xs text-text-tertiary">
								{{ t(getDirectionLabel(rel.direction)) }}
							</span>
							<span class="text-xs px-1.5 py-0.5 rounded bg-bg-elevated text-text-secondary">
								{{
									relationshipLabel(
										('displayRelationship' in rel ? rel.displayRelationship : undefined) ||
											rel.relationship
									)
								}}
							</span>
							<!-- Inline confidence editor: percentage is a button that
							     reveals the same slider the Add form uses. -->
							<div v-if="editingConfidenceId === rel._id" class="flex items-center gap-1.5">
								<input
									v-model.number="editingConfidence"
									type="range"
									:aria-valuetext="confidenceLabel(editingConfidence)"
									min="0"
									max="1"
									step="0.1"
									class="w-24 h-2 bg-bg-elevated rounded-lg appearance-none cursor-pointer accent-brand"
									:aria-label="
										t('components.contacts.relationshipsTab.confidenceFor', {
											target:
												rel.relatedContact?.email ??
												t('components.contacts.relationshipsTab.confidenceForFallback'),
										})
									"
								/>
								<span class="text-xs text-text-secondary w-16 text-right">
									{{ confidenceLabel(editingConfidence) }}
								</span>
								<UiTooltip :text="t('components.contacts.relationshipsTab.saveConfidence')">
									<button
										type="button"
										class="p-1 rounded text-text-tertiary hover:text-brand hover:bg-bg-elevated transition-colors"
										:aria-label="t('components.contacts.relationshipsTab.saveConfidence')"
										@click="saveConfidence(rel._id)"
									>
										<CheckIcon class="w-3.5 h-3.5" />
									</button>
								</UiTooltip>
								<UiTooltip :text="t('common.cancel')">
									<button
										type="button"
										class="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
										:aria-label="t('common.cancel')"
										@click="cancelEditConfidence"
									>
										<CloseIcon class="w-3.5 h-3.5" />
									</button>
								</UiTooltip>
							</div>
							<UiTooltip v-else :text="t('components.contacts.relationshipsTab.editConfidence')">
								<!-- The value is all it shows; the action is named for assistive tech. -->
								<button
									type="button"
									class="text-xs text-text-tertiary hover:text-brand transition-colors"
									@click="startEditConfidence(rel._id, rel.confidence ?? 1)"
								>
									<span class="sr-only">{{
										t('components.contacts.relationshipsTab.editConfidence')
									}}</span>
									{{ confidenceLabel(rel.confidence ?? 1) }}
								</button>
							</UiTooltip>
						</div>
					</div>
					<UiTooltip :text="t('components.contacts.relationshipsTab.removeRelationship')">
						<button
							type="button"
							class="inline-flex items-center justify-center p-1.5 pointer-coarse:size-11 rounded text-text-tertiary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:text-error hover:bg-error-subtle transition-[color,background-color,opacity]"
							:aria-label="t('components.contacts.relationshipsTab.removeRelationship')"
							@click="onRemove(rel._id)"
						>
							<TrashIcon class="w-4 h-4" />
						</button>
					</UiTooltip>
				</div>
			</div>
		</div>
	</div>
</template>
