<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	listTriggerEditorModules,
	triggerEditorModuleFor,
	type TriggerConfigByKind,
	type TriggerKind,
} from '~/composables/automations/triggers';

useHead({ title: 'Create Automation — Owlat' });

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
	label: 'Create automation',
});
const { run: updateTrigger } = useBackendOperation(api.automations.automations.updateTrigger, {
	label: 'Update automation trigger',
});

// Query for contact properties (for Contact Updated trigger)
const { data: contactProperties } = useOrganizationQuery(api.contacts.properties.listByOrganization);

// Query for topics (for Topic Subscribed trigger)
const { results: topics } = useTopicsList();

// Hydrate the form from the existing automation when editing its trigger.
const { data: existingAutomation } = useConvexQuery(
	api.automations.automations.get,
	() => (editId.value ? { automationId: editId.value as Id<'automations'> } : 'skip')
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

// Trigger type catalog — derived from the editor module registry.
const triggerTypes = computed(() =>
	listTriggerEditorModules().map((m) => ({
		id: m.kind,
		label: m.label,
		description: m.description,
		icon: m.icon,
		color: m.color,
		requiresConfig: m.requiresConfig,
	}))
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
		errors.value.name = 'Automation name is required';
	}

	if (!selectedTriggerType.value) {
		errors.value.trigger = 'Please select a trigger type';
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
			if (!newAutomationId) return;
			automationId.value = newAutomationId;
		} else {
			// Update trigger if automation already exists
			if (
				(await updateTrigger({
					automationId: automationId.value,
					triggerType: selectedTriggerType.value,
					triggerConfig: getTriggerConfig(),
				})) === undefined
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
const currentTriggerRequiresConfig = computed(() => selectedTriggerModule.value?.requiresConfig ?? false);

// Check if trigger configuration is complete
const isTriggerConfigComplete = computed(() => {
	if (!selectedTriggerModule.value) return false;
	if (!selectedTriggerModule.value.requiresConfig) return true;
	const error = (selectedTriggerModule.value.validateForSubmit as (c: unknown) => string | null)(
		triggerConfig.value
	);
	return error === null;
});

// Get color class for trigger type
const getTriggerColorClass = (color: string, selected: boolean) => {
	if (selected) {
		switch (color) {
			case 'lime':
				return 'border-brand bg-brand/5';
			case 'lavender':
				return 'border-brand bg-brand/5';
			case 'warning':
				return 'border-warning bg-warning/5';
			case 'success':
				return 'border-success bg-success/5';
			default:
				return 'border-brand bg-brand/5';
		}
	}
	return 'border-border-subtle hover:border-border-default';
};

// Get icon color class
const getIconColorClass = (color: string) => {
	switch (color) {
		case 'lime':
			return 'text-brand bg-brand/10';
		case 'lavender':
			return 'text-brand bg-brand/10';
		case 'warning':
			return 'text-warning bg-warning/10';
		case 'success':
			return 'text-success bg-success/10';
		default:
			return 'text-brand bg-brand/10';
	}
};
</script>

<template>
	<div class="min-h-full bg-bg-base">
		<!-- Header -->
		<div class="bg-bg-elevated border-b border-border-subtle">
			<div class="max-w-4xl mx-auto px-6 py-4">
				<div class="flex items-center gap-4">
					<button
						class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
						@click="handleCancel"
					 aria-label="Back">
						<Icon name="lucide:arrow-left" class="w-5 h-5" />
					</button>
					<div>
						<h1 class="text-lg font-semibold text-text-primary">
							{{ isEditMode ? 'Edit Trigger' : 'Create Automation' }}
						</h1>
						<p class="text-sm text-text-secondary">Set up an automated email workflow</p>
					</div>
				</div>
			</div>
		</div>

		<!-- Progress Indicator -->
		<div class="bg-bg-elevated border-b border-border-subtle">
			<div class="max-w-4xl mx-auto px-6 py-4">
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-2">
						<div
							class="flex items-center justify-center w-8 h-8 rounded-full bg-brand/20 text-brand border-2 border-brand text-sm font-medium"
						>
							1
						</div>
						<span class="text-sm font-medium text-text-primary">Choose Trigger</span>
					</div>
					<div class="flex-1 h-0.5 bg-border-subtle" />
					<div class="flex items-center gap-2">
						<div
							class="flex items-center justify-center w-8 h-8 rounded-full bg-bg-surface text-text-tertiary border border-border-subtle text-sm font-medium"
						>
							2
						</div>
						<span class="text-sm font-medium text-text-tertiary">Build Workflow</span>
					</div>
				</div>
			</div>
		</div>

		<!-- Content -->
		<div class="max-w-4xl mx-auto px-6 py-8">
			<div class="card p-6">
				<!-- Section Header -->
				<div class="mb-6">
					<h2 class="text-xl font-semibold text-text-primary">Choose a Trigger</h2>
					<p class="text-text-secondary mt-1">
						Select what event will start this automation workflow.
					</p>
				</div>

				<form @submit.prevent="handleSubmit">
					<div class="space-y-6">
						<!-- Automation Name -->
						<div>
							<label for="automationName" class="label flex items-center gap-2">
								<Icon name="lucide:file-text" class="w-4 h-4 text-text-tertiary" />
								Automation Name <span class="text-error">*</span>
							</label>
							<input
								id="automationName"
								v-model="automationName"
								type="text"
								placeholder="e.g., Welcome Series, Re-engagement Flow"
								:class="['input mt-1.5', errors.name ? 'input-error' : '']"
							/>
							<p v-if="errors.name" class="mt-1.5 text-sm text-error">
								{{ errors.name }}
							</p>
							<p v-else class="mt-1.5 text-sm text-text-tertiary">
								A name to identify this automation in your dashboard.
							</p>
						</div>

						<!-- Automation Description (optional) -->
						<div>
							<label for="automationDescription" class="label flex items-center gap-2">
								<Icon name="lucide:file-text" class="w-4 h-4 text-text-tertiary" />
								Description <span class="text-text-tertiary">(optional)</span>
							</label>
							<textarea
								id="automationDescription"
								v-model="automationDescription"
								placeholder="Describe what this automation does..."
								rows="2"
								class="input mt-1.5 resize-none"
							/>
						</div>

						<!-- Trigger Selection -->
						<div>
							<label class="label flex items-center gap-2 mb-3">
								<Icon name="lucide:zap" class="w-4 h-4 text-text-tertiary" />
								Trigger Type <span class="text-error">*</span>
							</label>

							<!-- Trigger Options Grid -->
							<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
								<button
									v-for="trigger in triggerTypes"
									:key="trigger.id"
									type="button"
									:class="[
										'flex items-start gap-4 p-4 border rounded-lg text-left transition-colors',
										getTriggerColorClass(trigger.color, selectedTriggerType === trigger.id),
									]"
									@click="handleTriggerSelect(trigger.id)"
								>
									<!-- Icon -->
									<div :class="['p-3 rounded-lg shrink-0 flex items-center justify-center', getIconColorClass(trigger.color)]">
										<Icon :name="trigger.icon" class="w-5 h-5" />
									</div>
									<!-- Content -->
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2">
											<span class="font-medium text-text-primary">{{ trigger.label }}</span>
											<Icon v-if="selectedTriggerType === trigger.id" name="lucide:check" class="w-4 h-4 text-brand" />
										</div>
										<p class="text-sm text-text-secondary mt-1">
											{{ trigger.description }}
										</p>
									</div>
								</button>
							</div>

							<p v-if="errors.trigger" class="mt-3 text-sm text-error">
								{{ errors.trigger }}
							</p>
						</div>

						<!-- Trigger Configuration (per-kind editor module dispatch) -->
						<div
							v-if="selectedTriggerModule && selectedTriggerModule.requiresConfig && selectedTriggerModule.EditorComponent"
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
								<Icon name="lucide:check" class="w-5 h-5 text-brand mt-0.5" />
								<div>
									<p class="text-sm font-medium text-text-primary">Ready to use</p>
									<p class="text-sm text-text-secondary mt-1">
										This trigger will fire automatically whenever a new contact is added to your
										audience via any method (API, import, or form submission).
									</p>
								</div>
							</div>
						</div>
					</div>

					<!-- Actions -->
					<div class="flex items-center justify-between mt-8 pt-6 border-t border-border-subtle">
						<button type="button" class="btn btn-secondary" @click="handleCancel">Cancel</button>
						<button
							type="submit"
							class="btn btn-primary gap-2"
							:disabled="
								isSaving ||
								!selectedTriggerType ||
								!automationName.trim() ||
								(currentTriggerRequiresConfig && !isTriggerConfigComplete)
							"
						>
							<Icon v-if="isSaving" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
							{{ isSaving ? 'Creating...' : 'Continue to Workflow' }}
							<Icon v-if="!isSaving" name="lucide:arrow-right" class="w-4 h-4" />
						</button>
					</div>
				</form>
			</div>
		</div>
	</div>
</template>
