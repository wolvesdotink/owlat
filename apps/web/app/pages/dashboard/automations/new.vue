<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	triggerEditorModuleFor,
	type TriggerConfigByKind,
	type TriggerKind,
} from '~/composables/automations/triggers';
import AutomationsTriggerPicker from '~/components/automations/TriggerPicker.vue';
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, FileTextIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const { t } = useI18n();

useHead({ title: () => t('dashboard.automations.new.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();
const route = useRoute();
const { hasActiveOrganization } = useOrganizationContext();

// Automation state
const automationId = ref<Id<'automations'> | null>(null);

// Edit mode: the workflow editor's trigger-card "Edit" link routes here with
// ?edit=<id>. Without hydrating it, submit always took the create branch and
// orphaned the original with a duplicate draft. (updateTrigger is draft-only;
// the link is only surfaced for draft automations.)
const editId = computed(() => (route.query['edit'] as string | undefined) || null);
const isEditMode = computed(() => editId.value !== null);

// Form state
const automationName = ref('');
const automationDescription = ref('');
const selectedTriggerType = ref<TriggerKind | null>(null);

// Trigger configuration — typed discriminated config keyed by selected kind
const triggerConfig = ref<TriggerConfigByKind[TriggerKind] | null>(null);

// Form errors
const errors = ref<{
	name?: string;
	trigger?: string;
	triggerConfig?: string;
}>({});

// Loading state
const isSaving = ref(false);

// Mutations
const { run: createAutomation } = useBackendOperation(api.automations.automations.create, {
	label: () => t('dashboard.automations.new.operations.create'),
});
const { run: updateAutomationDetails } = useBackendOperation(api.automations.automations.update, {
	label: () => t('dashboard.automations.new.operations.updateDetails'),
});
const { run: updateTrigger } = useBackendOperation(api.automations.automations.updateTrigger, {
	label: () => t('dashboard.automations.new.operations.updateTrigger'),
});

// Query for contact properties (for Contact Updated trigger)
const { data: contactProperties } = useOrganizationQuery(
	api.contacts.properties.listByOrganization
);

// Query for topics (for Topic Subscribed trigger)
const { results: topics } = useTopicsList();

// Hydrate the form from the existing automation when editing its trigger.
const { data: existingAutomation } = useConvexQuery(api.automations.automations.get, () =>
	editId.value ? { automationId: editId.value as Id<'automations'> } : 'skip'
);
watch(
	existingAutomation,
	(a) => {
		if (!a) return;
		automationId.value = a._id;
		automationName.value = a.name;
		automationDescription.value = a.description ?? '';
		selectedTriggerType.value = a.triggerType as TriggerKind;
		triggerConfig.value = (a.triggerConfig as TriggerConfigByKind[TriggerKind] | undefined) ?? null;
	},
	{ immediate: true }
);

const selectedTriggerModule = computed(() =>
	selectedTriggerType.value ? triggerEditorModuleFor(selectedTriggerType.value) : null
);

// Resolve trigger config for submission — the module owns the persistence shape.
const getTriggerConfig = () => {
	// null is the canonical "no config" (e.g. contact_created); the guard above
	// already returns undefined for it, so just return the resolved config.
	if (!selectedTriggerType.value) return undefined;
	return triggerConfig.value ?? undefined;
};

// Validate form
const validateForm = (): boolean => {
	errors.value = {};

	if (!automationName.value.trim()) {
		errors.value.name = t('dashboard.automations.new.validation.nameRequired');
	}

	if (!selectedTriggerType.value) {
		errors.value.trigger = t('dashboard.automations.new.validation.triggerRequired');
		return false;
	}

	const module = triggerEditorModuleFor(selectedTriggerType.value);
	const configError = (module.validateForSubmit as (c: unknown) => string | null)(
		triggerConfig.value
	);
	if (configError) {
		errors.value.triggerConfig = configError;
	}

	return Object.keys(errors.value).length === 0;
};

// Handle form submission - create automation and proceed to workflow editor
const handleSubmit = async () => {
	if (!validateForm() || !hasActiveOrganization.value || !selectedTriggerType.value) return;

	isSaving.value = true;

	try {
		// Create automation if not exists
		if (!automationId.value) {
			const newAutomationId = await createAutomation({
				name: automationName.value.trim(),
				description: automationDescription.value.trim() || undefined,
				triggerType: selectedTriggerType.value,
				triggerConfig: getTriggerConfig(),
			});
			if (!newAutomationId.ok) return;
			automationId.value = newAutomationId.result;
		} else {
			// The name and description are editable here too, so a change to
			// them is saved with the trigger instead of being dropped.
			const name = automationName.value.trim();
			const description = automationDescription.value.trim();
			const existing = existingAutomation.value;
			if (
				existing &&
				(name !== existing.name || description !== (existing.description ?? '')) &&
				!(
					await updateAutomationDetails({
						automationId: automationId.value,
						name,
						description,
					})
				).ok
			) {
				return;
			}
			// Update trigger if automation already exists
			if (
				!(
					await updateTrigger({
						automationId: automationId.value,
						triggerType: selectedTriggerType.value,
						triggerConfig: getTriggerConfig(),
					})
				).ok
			) {
				return;
			}
		}

		// Navigate to the workflow editor (to be implemented in US-042)
		router.push(`/dashboard/automations/${automationId.value}/edit`);
	} finally {
		isSaving.value = false;
	}
};

// Navigate back to automations list
const handleCancel = () => {
	router.push('/dashboard/automations');
};

// Handle trigger type selection
const handleTriggerSelect = (triggerType: TriggerKind) => {
	selectedTriggerType.value = triggerType;
	// Reset config to the new kind's default shape
	const module = triggerEditorModuleFor(triggerType);
	triggerConfig.value = module.createDefault();
	errors.value.triggerConfig = undefined;
};

// Check if current trigger requires additional configuration
const currentTriggerRequiresConfig = computed(
	() => selectedTriggerModule.value?.requiresConfig ?? false
);

// What still keeps Continue disabled, said next to it.
const missingText = computed(() => {
	const missing: string[] = [];
	if (!automationName.value.trim()) {
		missing.push(t('dashboard.automations.new.validation.nameRequired'));
	}
	if (!selectedTriggerType.value) {
		missing.push(t('dashboard.automations.new.validation.triggerRequired'));
	} else if (currentTriggerRequiresConfig.value && !isTriggerConfigComplete.value) {
		missing.push(t('dashboard.automations.new.validation.triggerConfigIncomplete'));
	}
	return missing.join(' · ');
});

// Check if trigger configuration is complete
const isTriggerConfigComplete = computed(() => {
	if (!selectedTriggerModule.value) return false;
	if (!selectedTriggerModule.value.requiresConfig) return true;
	const error = (selectedTriggerModule.value.validateForSubmit as (c: unknown) => string | null)(
		triggerConfig.value
	);
	return error === null;
});
</script>

<template>
	<div class="min-h-full bg-bg-base">
		<!-- Header -->
		<div class="bg-bg-elevated border-b border-border-subtle">
			<div class="max-w-4xl mx-auto px-6 py-4">
				<div class="flex items-center gap-4">
					<button
						type="button"
						class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand pointer-coarse:flex pointer-coarse:size-11 pointer-coarse:items-center pointer-coarse:justify-center"
						@click="handleCancel"
						:aria-label="t('common.back')"
					>
						<ArrowLeftIcon class="w-5 h-5" />
					</button>
					<div>
						<h1 class="text-lg font-semibold text-text-primary">
							{{
								isEditMode
									? t('dashboard.automations.new.editTriggerTitle')
									: t('dashboard.automations.new.title')
							}}
						</h1>
						<p class="text-sm text-text-secondary">{{ t('dashboard.automations.new.subtitle') }}</p>
					</div>
				</div>
			</div>
		</div>

		<!-- Progress Indicator -->
		<div class="bg-bg-elevated border-b border-border-subtle">
			<div class="max-w-4xl mx-auto px-6 py-4">
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-2" aria-current="step">
						<div
							class="flex items-center justify-center w-8 h-8 rounded-full bg-brand text-text-inverse border-2 border-brand text-sm font-medium"
						>
							1
						</div>
						<span class="text-sm font-medium text-text-primary">{{
							t('dashboard.automations.new.steps.chooseTrigger')
						}}</span>
					</div>
					<div class="flex-1 h-0.5 bg-border-subtle" aria-hidden="true" />
					<div class="flex items-center gap-2">
						<div
							class="flex items-center justify-center w-8 h-8 rounded-full bg-bg-surface text-text-tertiary border border-border-subtle text-sm font-medium"
						>
							2
						</div>
						<span class="text-sm font-medium text-text-tertiary">{{
							t('dashboard.automations.new.steps.buildWorkflow')
						}}</span>
					</div>
				</div>
			</div>
		</div>

		<!-- Content -->
		<div class="max-w-4xl mx-auto px-6 py-8">
			<div class="card p-6">
				<!-- Section Header -->
				<div class="mb-6">
					<h2 class="text-xl font-semibold text-text-primary">
						{{ t('dashboard.automations.new.chooseTrigger.title') }}
					</h2>
					<p class="text-text-secondary mt-1">
						{{ t('dashboard.automations.new.chooseTrigger.subtitle') }}
					</p>
				</div>

				<form @submit.prevent="handleSubmit">
					<div class="space-y-6">
						<!-- Automation Name -->
						<div>
							<label for="automationName" class="label flex items-center gap-2">
								<FileTextIcon class="w-4 h-4 text-text-tertiary" />
								{{ t('dashboard.automations.new.form.nameLabel') }}
								<span class="text-error">*</span>
							</label>
							<input
								id="automationName"
								v-model="automationName"
								type="text"
								:placeholder="t('dashboard.automations.new.form.namePlaceholder')"
								:class="['input mt-1.5', errors.name ? 'input-error' : '']"
							/>
							<p v-if="errors.name" class="mt-1.5 text-sm text-error">
								{{ errors.name }}
							</p>
							<p v-else class="mt-1.5 text-sm text-text-tertiary">
								{{ t('dashboard.automations.new.form.nameHelp') }}
							</p>
						</div>

						<!-- Automation Description (optional) -->
						<div>
							<label for="automationDescription" class="label flex items-center gap-2">
								<FileTextIcon class="w-4 h-4 text-text-tertiary" />
								{{ t('common.description') }}
								<span class="text-text-tertiary">{{
									t('dashboard.automations.new.form.optionalHint')
								}}</span>
							</label>
							<textarea
								id="automationDescription"
								v-model="automationDescription"
								:placeholder="t('dashboard.automations.new.form.descriptionPlaceholder')"
								rows="2"
								class="input mt-1.5 resize-none"
							/>
						</div>

						<!-- Trigger Selection -->
						<AutomationsTriggerPicker
							:model-value="selectedTriggerType"
							:error="errors.trigger"
							@select="handleTriggerSelect"
						/>

						<!-- Trigger Configuration (per-kind editor module dispatch) -->
						<div
							v-if="
								selectedTriggerModule &&
								selectedTriggerModule.requiresConfig &&
								selectedTriggerModule.EditorComponent
							"
							class="p-4 bg-bg-surface border border-border-subtle rounded-lg"
						>
							<component
								:is="selectedTriggerModule.EditorComponent"
								:model-value="triggerConfig"
								:contact-properties="contactProperties"
								:topics="topics"
								:error="errors.triggerConfig"
								@update:model-value="triggerConfig = $event"
							/>
						</div>

						<!-- Contact Created Info (no config needed) -->
						<div
							v-if="selectedTriggerType === 'contact_created'"
							class="p-4 bg-brand/5 border border-brand/20 rounded-lg"
						>
							<div class="flex items-start gap-3">
								<CheckIcon class="w-5 h-5 text-brand mt-0.5" />
								<div>
									<p class="text-sm font-medium text-text-primary">
										{{ t('dashboard.automations.new.contactCreatedInfo.title') }}
									</p>
									<p class="text-sm text-text-secondary mt-1">
										{{ t('dashboard.automations.new.contactCreatedInfo.body') }}
									</p>
								</div>
							</div>
						</div>
					</div>

					<!-- Actions -->
					<div
						class="flex flex-wrap items-center justify-between gap-3 mt-8 pt-6 border-t border-border-subtle"
					>
						<UiButton variant="secondary" type="button" @click="handleCancel">{{
							t('common.cancel')
						}}</UiButton>
						<div class="flex flex-wrap items-center justify-end gap-3 ml-auto">
							<p
								v-if="missingText && !isSaving"
								id="automation-new-missing"
								class="text-sm text-text-tertiary text-right"
							>
								{{ missingText }}
							</p>
							<UiButton
								type="submit"
								class="gap-2"
								:aria-describedby="missingText && !isSaving ? 'automation-new-missing' : undefined"
								:disabled="
									isSaving ||
									!selectedTriggerType ||
									!automationName.trim() ||
									(currentTriggerRequiresConfig && !isTriggerConfigComplete)
								"
							>
								<SpinnerIcon v-if="isSaving" class="w-4 h-4" />
								{{
									isEditMode
										? isSaving
											? t('common.saving')
											: t('dashboard.automations.new.saveTrigger')
										: isSaving
											? t('dashboard.automations.new.creating')
											: t('dashboard.automations.new.continue')
								}}
								<ArrowRightIcon v-if="!isSaving" class="w-4 h-4" />
							</UiButton>
						</div>
					</div>
				</form>
			</div>
		</div>
	</div>
</template>
