<script setup lang="ts">
import { VueDraggable } from 'vue-draggable-plus';
import { api } from '@owlat/api';
import { UnsavedChangesDialog } from '@owlat/email-builder';
import type { Id } from '@owlat/api/dataModel';
import { computed } from 'vue';
import { provideConditionEditorContext } from '~/composables/conditions';
import { stepEditorModuleFor, type StepKind } from '~/composables/automations/steps';
import { triggerEditorModuleFor, type TriggerKind } from '~/composables/automations/triggers';

const { t } = useI18n();

useHead({ title: () => t('dashboard.automations.detail.edit.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();
// Get automation ID from route
const automationId = useRouteId<'automations'>();

// Fetch automation with steps
const { data: automation, isLoading: isLoadingAutomation } = useConvexQuery(
	api.automations.automations.getWithRelations,
	() => ({ automationId: automationId.value })
);

// Fetch email templates for email step selection (marketing templates can be used in automations)
const { results: emailTemplates } = usePaginatedQuery(
	api.emailTemplates.emails.list,
	() => ({ type: 'marketing' as const }),
	{ initialNumItems: 100 }
);

// Mutations for automation status management
const { run: activateAutomation } = useBackendOperation(api.automations.automations.activate, {
	label: () => t('dashboard.automations.detail.edit.operations.activate'),
});
const { run: pauseAutomation } = useBackendOperation(api.automations.automations.pause, {
	label: () => t('dashboard.automations.detail.edit.operations.pause'),
});
const { run: resumeAutomation } = useBackendOperation(api.automations.automations.resume, {
	label: () => t('dashboard.automations.detail.edit.operations.resume'),
});
const { run: updateAutomation } = useBackendOperation(api.automations.automations.update, {
	label: () => t('dashboard.automations.detail.edit.operations.saveDraft'),
});

// Fetch contact properties for condition step configuration
const { data: contactProperties } = useOrganizationQuery(
	api.contacts.properties.listByOrganization
);

// Fetch topics for condition step configuration
const { results: topics } = useTopicsList();

// Use automation steps composable
const {
	// State
	isSaving,
	isAddStepDropdownOpen,
	addStepDropdownIndex,
	selectedStepId,
	selectedStep,
	mutableSteps,
	stepTypes,
	canActivate,
	currentConfig,
	isCurrentConfigDirty,

	// Methods
	handleAddStep,
	handleDeleteStep,
	handleDragEnd,
	handleUpdateStepConfig,
	closeDropdowns,

	// Description helper
	getStepDescription,
} = useAutomationSteps(automationId, automation, emailTemplates);

// Provide reference data to descendant Condition editor modules
provideConditionEditorContext({ contactProperties, topics });

// Toast notification
const { showToast } = useToast();

// Page-level UI state
const isSavingDraft = ref(false);
const isActivating = ref(false);
const showActivateConfirmModal = ref(false);

// Trigger display — resolved through the trigger editor module registry.
const getTriggerInfo = (triggerType: string) => {
	const module = triggerEditorModuleFor(triggerType as TriggerKind);
	return { label: module.label, icon: module.icon, color: module.color };
};

const topicsRef = computed(() => topics.value ?? []);
// The trigger registry hands back translatable text rather than a finished
// sentence: a bare key for a constant summary, `{ key, params }` for a
// parameterized one.
type RegistrySummary = string | { key: string; params?: Record<string, unknown> };
const renderRegistrySummary = (summary: RegistrySummary): string =>
	typeof summary === 'string' ? t(summary) : t(summary.key, summary.params ?? {});

const triggerSummary = computed(() => {
	if (!automation.value?.triggerConfig) return '';
	const module = triggerEditorModuleFor(automation.value.triggerType as TriggerKind);
	return renderRegistrySummary(
		(module.getSummary as (c: unknown, ctx: { topics: typeof topicsRef }) => RegistrySummary)(
			automation.value.triggerConfig,
			{ topics: topicsRef }
		)
	);
});

// Per-step display — resolved through the step editor module registry.
const stepInfo = (stepType: string) => {
	const module = stepEditorModuleFor(stepType as StepKind);
	return { label: module.label, icon: module.icon };
};

// Page-local accent palette per step kind. Lives at the page boundary
// (not on the module) because the funnel page in `[id]/index.vue` uses a
// different palette for the same kinds. Adding a step kind to `StepKind`
// surfaces the missing entry as a compile error here.
type StepAccent = {
	readonly iconClass: string;
	readonly pill: { readonly bg: string; readonly border: string; readonly text: string } | null;
};

const STEP_ACCENT: Readonly<Record<StepKind, StepAccent>> = {
	email: { iconClass: 'text-brand bg-brand/10', pill: null },
	delay: {
		iconClass: 'text-brand bg-brand/10',
		pill: { bg: 'bg-brand/10', border: 'border-brand/30', text: 'text-brand' },
	},
	condition: {
		iconClass: 'text-warning bg-warning/10',
		pill: { bg: 'bg-warning/10', border: 'border-warning/30', text: 'text-warning' },
	},
};

const stepAccent = (stepType: string): StepAccent => STEP_ACCENT[stepType as StepKind];

// Handle automation activation/pause
const handleToggleStatus = async () => {
	if (!automation.value) return;

	isActivating.value = true;

	try {
		if (automation.value.status === 'active') {
			if ((await pauseAutomation({ automationId: automationId.value })) === undefined) return;
			showToast(t('dashboard.automations.detail.edit.toasts.paused'));
		} else if (automation.value.status === 'paused') {
			if ((await resumeAutomation({ automationId: automationId.value })) === undefined) return;
			showToast(t('dashboard.automations.detail.edit.toasts.resumed'));
		} else {
			// Draft - activate
			if ((await activateAutomation({ automationId: automationId.value })) === undefined) return;
			showToast(t('dashboard.automations.detail.edit.toasts.activated'));
		}
	} finally {
		isActivating.value = false;
	}
};

// Navigate back. `router.push` triggers the unsaved-changes route guard below
// when the open step panel has edits, so Back prompts instead of dropping them.
const handleBack = () => {
	router.push('/dashboard/automations');
};

// Unsaved-changes guard for the open step panel. Leaving the page (Back, the
// trigger "Edit" link, or any in-app navigation) while the panel holds edits
// prompts to save/discard. Reuses the shared composable + dialog. `onSave`
// persists the open step config before navigating.
const {
	showDialog: showLeaveDialog,
	confirmDiscard: confirmLeaveDiscard,
	confirmSave: confirmLeaveSave,
	cancelNavigation: cancelLeave,
	setHasChanges,
} = useUnsavedChanges({
	onSave: async () => {
		await handleUpdateStepConfig();
		// A failed step-config save keeps the panel dirty; throw so the guard
		// stays put instead of clearing the flag and navigating away — mirrors
		// the sibling saveStepSwitch and the campaign/settings surfaces.
		if (isCurrentConfigDirty.value) throw new Error('Save failed');
	},
});
watch(isCurrentConfigDirty, (dirty) => setHasChanges(dirty), { immediate: true });

// Guarded step selection: switching steps re-derives currentConfig from the
// persisted step, which would silently drop unsaved panel edits. Prompt first.
const pendingStepId = ref<Id<'automationSteps'> | null>(null);
const showStepSwitchDialog = ref(false);
const requestSelectStep = (stepId: Id<'automationSteps'>) => {
	if (stepId === selectedStepId.value) return;
	if (isCurrentConfigDirty.value) {
		pendingStepId.value = stepId;
		showStepSwitchDialog.value = true;
		return;
	}
	selectedStepId.value = stepId;
};
const applyPendingStep = () => {
	selectedStepId.value = pendingStepId.value;
	pendingStepId.value = null;
	showStepSwitchDialog.value = false;
};
const discardStepSwitch = () => {
	applyPendingStep();
};
const saveStepSwitch = async () => {
	await handleUpdateStepConfig();
	// A failed save keeps the panel dirty — stay on the current step so edits
	// aren't lost, leaving the dialog up.
	if (isCurrentConfigDirty.value) return;
	applyPendingStep();
};
const cancelStepSwitch = () => {
	pendingStepId.value = null;
	showStepSwitchDialog.value = false;
};

// Handle save draft (save automation name/description + the open step config)
const handleSaveDraft = async () => {
	if (!automation.value) return;

	isSavingDraft.value = true;

	try {
		// Persist the open step's edits too, so Save Draft doesn't drop panel work.
		if (selectedStepId.value && isCurrentConfigDirty.value) {
			await handleUpdateStepConfig({ silent: true });
		}
		const result = await updateAutomation({
			automationId: automationId.value,
			name: automation.value.name,
			description: automation.value.description,
		});
		if (result === undefined) return;
		showToast(t('dashboard.automations.detail.edit.toasts.draftSaved'));
	} finally {
		isSavingDraft.value = false;
	}
};

// Show activate confirmation modal
const handleShowActivateConfirm = () => {
	if (!canActivate.value.valid) {
		showToast(
			canActivate.value.reasons[0] || t('dashboard.automations.detail.edit.cannotActivate'),
			'error'
		);
		return;
	}
	showActivateConfirmModal.value = true;
};

// Confirm activation
const handleConfirmActivate = async () => {
	showActivateConfirmModal.value = false;
	await handleToggleStatus();
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
			return 'text-text-tertiary bg-bg-surface';
	}
};

// Computed description for the selected step (used by the step preview)
const selectedStepConditionDescription = computed(() => {
	if (!selectedStep.value) return t('dashboard.automations.detail.edit.configureCondition');
	return getStepDescription(selectedStep.value);
});

// Close dropdown when clicking outside
onMounted(() => {
	document.addEventListener('click', closeDropdowns);
});

onUnmounted(() => {
	document.removeEventListener('click', closeDropdowns);
});
</script>

<template>
	<div class="min-h-full bg-bg-base flex flex-col">
		<!-- Header -->
		<div class="bg-bg-elevated border-b border-border-subtle shrink-0">
			<div class="max-w-7xl mx-auto px-6 py-4">
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-4">
						<button
							class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
							@click="handleBack"
							:aria-label="t('common.back')"
						>
							<Icon name="lucide:arrow-left" class="w-5 h-5" />
						</button>
						<div v-if="automation">
							<h1 class="text-lg font-semibold text-text-primary">{{ automation.name }}</h1>
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.automations.detail.edit.editWorkflow') }}
							</p>
						</div>
						<div v-else-if="isLoadingAutomation" class="animate-pulse">
							<div class="h-5 w-40 bg-bg-surface rounded" />
							<div class="h-4 w-24 bg-bg-surface rounded mt-1" />
						</div>
					</div>

					<!-- Status and Actions -->
					<div v-if="automation" class="flex items-center gap-3">
						<!-- Status Badge -->
						<span
							:class="[
								'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
								automation.status === 'active'
									? 'bg-success/10 text-success'
									: automation.status === 'paused'
										? 'bg-warning/10 text-warning'
										: 'bg-bg-surface text-text-secondary',
							]"
						>
							<span
								class="w-1.5 h-1.5 rounded-full"
								:class="[
									automation.status === 'active'
										? 'bg-success'
										: automation.status === 'paused'
											? 'bg-warning'
											: 'bg-text-tertiary',
								]"
							/>
							{{
								automation.status === 'active'
									? t('common.active')
									: automation.status === 'paused'
										? t('dashboard.automations.detail.edit.status.paused')
										: t('dashboard.automations.detail.edit.status.draft')
							}}
						</span>

						<!-- Save Draft Button (only for draft status) -->
						<UiButton
							variant="secondary"
							v-if="automation.status === 'draft'"
							class="gap-2"
							:disabled="isSavingDraft"
							@click="handleSaveDraft"
						>
							<Icon v-if="isSavingDraft" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
							<Icon v-else name="lucide:save" class="w-4 h-4" />
							{{ t('dashboard.automations.detail.edit.saveDraft') }}
						</UiButton>

						<!-- Activate/Pause Button -->
						<UiButton
							variant="secondary"
							v-if="automation.status === 'active'"
							class="gap-2"
							:disabled="isActivating"
							@click="handleToggleStatus"
						>
							<Icon v-if="isActivating" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
							<Icon v-else name="lucide:pause" class="w-4 h-4" />
							{{ t('dashboard.automations.detail.edit.pause') }}
						</UiButton>
						<UiButton
							v-else-if="automation.status === 'paused'"
							class="gap-2"
							:disabled="isActivating"
							@click="handleToggleStatus"
						>
							<Icon v-if="isActivating" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
							<Icon v-else name="lucide:play" class="w-4 h-4" />
							{{ t('dashboard.automations.detail.edit.resume') }}
						</UiButton>
						<UiButton
							v-else
							class="gap-2"
							:disabled="isActivating || !canActivate.valid"
							:title="
								!canActivate.valid
									? canActivate.reasons.join(', ')
									: t('dashboard.automations.detail.edit.activateTitle')
							"
							@click="handleShowActivateConfirm"
						>
							<Icon v-if="isActivating" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
							<Icon v-else name="lucide:play" class="w-4 h-4" />
							{{ t('dashboard.automations.detail.edit.activate') }}
						</UiButton>
					</div>
				</div>
			</div>
		</div>

		<!-- Progress Indicator -->
		<div class="bg-bg-elevated border-b border-border-subtle shrink-0">
			<div class="max-w-7xl mx-auto px-6 py-4">
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-2">
						<div
							class="flex items-center justify-center w-8 h-8 rounded-full bg-brand/20 text-brand border-2 border-brand text-sm font-medium"
						>
							<Icon name="lucide:check" class="w-4 h-4" />
						</div>
						<span class="text-sm font-medium text-text-primary">{{
							t('dashboard.automations.detail.edit.steps.chooseTrigger')
						}}</span>
					</div>
					<div class="flex-1 h-0.5 bg-brand" />
					<div class="flex items-center gap-2">
						<div
							class="flex items-center justify-center w-8 h-8 rounded-full bg-brand/20 text-brand border-2 border-brand text-sm font-medium"
						>
							2
						</div>
						<span class="text-sm font-medium text-text-primary">{{
							t('dashboard.automations.detail.edit.steps.buildWorkflow')
						}}</span>
					</div>
				</div>
			</div>
		</div>

		<!-- Loading State -->
		<div v-if="isLoadingAutomation" class="flex-1 flex items-center justify-center">
			<Icon name="lucide:loader-2" class="w-8 h-8 animate-spin text-brand" />
		</div>

		<!-- Not Found -->
		<div v-else-if="!automation" class="flex-1 flex items-center justify-center">
			<div class="text-center">
				<Icon name="lucide:alert-circle" class="w-12 h-12 text-text-tertiary mx-auto mb-4" />
				<h2 class="text-xl font-semibold text-text-primary mb-2">
					{{ t('dashboard.automations.detail.edit.notFound.title') }}
				</h2>
				<p class="text-text-secondary mb-4">
					{{ t('dashboard.automations.detail.edit.notFound.body') }}
				</p>
				<UiButton to="/dashboard/automations">{{
					t('dashboard.automations.detail.edit.notFound.action')
				}}</UiButton>
			</div>
		</div>

		<!-- Main Content - Two Panel Layout -->
		<div v-else class="flex-1 flex overflow-hidden">
			<!-- Workflow Canvas (Left Panel) -->
			<div class="flex-1 overflow-y-auto p-6">
				<div class="max-w-xl mx-auto">
					<!-- Trigger Node -->
					<div class="relative">
						<!-- Trigger Card -->
						<div class="card p-4">
							<div class="flex items-center gap-3">
								<div
									:class="[
										'p-2 rounded-lg',
										getIconColorClass(getTriggerInfo(automation.triggerType).color),
									]"
								>
									<Icon :name="getTriggerInfo(automation.triggerType).icon" class="w-5 h-5" />
								</div>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2">
										<span class="text-xs font-medium text-text-tertiary uppercase tracking-wide">{{
											t('dashboard.automations.detail.edit.trigger')
										}}</span>
									</div>
									<p class="font-medium text-text-primary">
										{{ t(getTriggerInfo(automation.triggerType).label) }}
									</p>
									<p v-if="automation.triggerConfig" class="text-sm text-text-secondary truncate">
										{{ triggerSummary }}
									</p>
								</div>
								<NuxtLink
									:to="`/dashboard/automations/new?edit=${automation._id}`"
									class="text-sm text-brand hover:underline"
								>
									{{ t('common.edit') }}
								</NuxtLink>
							</div>
						</div>

						<!-- Connector Line -->
						<div class="flex flex-col items-center">
							<div class="w-0.5 h-4 bg-border-default" />

							<!-- Add Step Button (at start) -->
							<div class="relative" @click.stop>
								<button
									class="flex items-center justify-center w-8 h-8 rounded-full bg-bg-surface border border-border-default text-text-tertiary hover:text-brand hover:border-brand transition-colors"
									@click="addStepDropdownIndex = addStepDropdownIndex === -1 ? null : -1"
									:aria-label="t('common.add')"
								>
									<Icon name="lucide:plus" class="w-4 h-4" />
								</button>

								<!-- Dropdown -->
								<div
									v-if="addStepDropdownIndex === -1"
									class="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-64 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg z-20"
								>
									<div class="p-2">
										<p
											class="text-xs font-medium text-text-tertiary uppercase tracking-wide px-2 py-1"
										>
											{{ t('dashboard.automations.detail.edit.addStep') }}
										</p>
										<button
											v-for="type in stepTypes"
											:key="type.id"
											class="flex items-center gap-3 w-full p-2 rounded-lg text-left transition-colors hover:bg-bg-surface"
											@click="handleAddStep(type.id, 0)"
										>
											<div
												:class="[
													'p-2 rounded-lg flex items-center justify-center',
													getIconColorClass(type.color),
												]"
											>
												<Icon
													:name="
														type.id === 'email'
															? 'lucide:mail'
															: type.id === 'delay'
																? 'lucide:clock'
																: 'lucide:git-branch'
													"
													class="w-4 h-4"
												/>
											</div>
											<div class="flex-1 min-w-0">
												<p class="font-medium text-text-primary text-sm">{{ t(type.label) }}</p>
												<p class="text-xs text-text-secondary">{{ t(type.description) }}</p>
											</div>
										</button>
									</div>
								</div>
							</div>

							<div class="w-0.5 h-4 bg-border-default" />
						</div>
					</div>

					<!-- Steps List -->
					<VueDraggable
						v-if="mutableSteps.length > 0"
						:model-value="mutableSteps"
						item-key="_id"
						handle=".drag-handle"
						ghost-class="opacity-50"
						@end="handleDragEnd"
					>
						<template #item="{ element: step, index }">
							<div class="relative">
								<!-- Step Card -->
								<div
									:class="[
										'card p-4 cursor-pointer transition-all',
										selectedStepId === step._id
											? 'ring-2 ring-brand border-brand'
											: 'hover:border-border-default',
									]"
									@click="requestSelectStep(step._id)"
								>
									<div class="flex items-center gap-3">
										<!-- Drag Handle -->
										<div
											class="drag-handle cursor-grab active:cursor-grabbing p-1 -ml-1 text-text-tertiary hover:text-text-secondary"
										>
											<Icon name="lucide:grip-vertical" class="w-4 h-4" />
										</div>

										<!-- Step Icon (resolved via the step editor module registry;
												page-local accent palette via STEP_ACCENT) -->
										<div
											:class="[
												'p-2 rounded-lg flex items-center justify-center',
												stepAccent(step.stepType).iconClass,
											]"
										>
											<Icon :name="stepInfo(step.stepType).icon" class="w-5 h-5" />
										</div>

										<!-- Step Content -->
										<div class="flex-1 min-w-0">
											<div class="flex items-center gap-2">
												<span
													class="text-xs font-medium text-text-tertiary uppercase tracking-wide"
												>
													{{
														t('dashboard.automations.detail.edit.stepNumber', { number: index + 1 })
													}}
												</span>
											</div>
											<p class="font-medium text-text-primary">
												{{ t(stepInfo(step.stepType).label) }}
											</p>
											<!-- Description: plain text when no pill accent, pill chrome when defined. -->
											<p
												v-if="!stepAccent(step.stepType).pill"
												class="text-sm text-text-secondary truncate"
											>
												{{ getStepDescription(step) }}
											</p>
											<div v-else class="mt-2">
												<div
													:class="[
														'inline-flex items-center gap-2 px-3 py-1.5 rounded-full border',
														stepAccent(step.stepType).pill!.bg,
														stepAccent(step.stepType).pill!.border,
													]"
												>
													<Icon
														:name="stepInfo(step.stepType).icon"
														:class="['w-3.5 h-3.5', stepAccent(step.stepType).pill!.text]"
													/>
													<span
														:class="['text-sm font-medium', stepAccent(step.stepType).pill!.text]"
													>
														{{ getStepDescription(step) }}
													</span>
												</div>
											</div>
										</div>

										<!-- Delete Button -->
										<button
											class="p-2 text-text-tertiary hover:text-error transition-colors"
											@click.stop="handleDeleteStep(step._id)"
											:aria-label="t('common.delete')"
										>
											<Icon name="lucide:trash-2" class="w-4 h-4" />
										</button>
									</div>
								</div>

								<!-- Connector Line -->
								<div class="flex flex-col items-center">
									<div class="w-0.5 h-4 bg-border-default" />

									<!-- Add Step Button (after this step) -->
									<div class="relative" @click.stop>
										<button
											class="flex items-center justify-center w-8 h-8 rounded-full bg-bg-surface border border-border-default text-text-tertiary hover:text-brand hover:border-brand transition-colors"
											@click="addStepDropdownIndex = addStepDropdownIndex === index ? null : index"
											:aria-label="t('common.add')"
										>
											<Icon name="lucide:plus" class="w-4 h-4" />
										</button>

										<!-- Dropdown -->
										<div
											v-if="addStepDropdownIndex === index"
											class="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-64 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg z-20"
										>
											<div class="p-2">
												<p
													class="text-xs font-medium text-text-tertiary uppercase tracking-wide px-2 py-1"
												>
													{{ t('dashboard.automations.detail.edit.addStep') }}
												</p>
												<button
													v-for="type in stepTypes"
													:key="type.id"
													class="flex items-center gap-3 w-full p-2 rounded-lg text-left transition-colors hover:bg-bg-surface"
													@click="handleAddStep(type.id, index + 1)"
												>
													<div
														:class="[
															'p-2 rounded-lg flex items-center justify-center',
															getIconColorClass(type.color),
														]"
													>
														<Icon
															:name="
																type.id === 'email'
																	? 'lucide:mail'
																	: type.id === 'delay'
																		? 'lucide:clock'
																		: 'lucide:git-branch'
															"
															class="w-4 h-4"
														/>
													</div>
													<div class="flex-1 min-w-0">
														<p class="font-medium text-text-primary text-sm">{{ t(type.label) }}</p>
														<p class="text-xs text-text-secondary">{{ t(type.description) }}</p>
													</div>
												</button>
											</div>
										</div>
									</div>

									<div v-if="index < mutableSteps.length - 1" class="w-0.5 h-4 bg-border-default" />
								</div>
							</div>
						</template>
					</VueDraggable>

					<!-- Empty State - No Steps -->
					<div v-else class="card p-8 text-center">
						<div
							class="w-16 h-16 mx-auto mb-4 rounded-full bg-bg-surface flex items-center justify-center"
						>
							<Icon name="lucide:zap" class="w-8 h-8 text-text-tertiary" />
						</div>
						<h3 class="text-lg font-semibold text-text-primary mb-2">
							{{ t('dashboard.automations.detail.edit.empty.title') }}
						</h3>
						<p class="text-text-secondary mb-4">
							{{ t('dashboard.automations.detail.edit.empty.body') }}
						</p>
						<div class="flex justify-center gap-3">
							<UiButton class="gap-2" @click="handleAddStep('email')">
								<Icon name="lucide:mail" class="w-4 h-4" />
								{{ t('dashboard.automations.detail.edit.empty.addEmail') }}
							</UiButton>
							<UiButton variant="secondary" class="gap-2" @click="handleAddStep('delay')">
								<Icon name="lucide:clock" class="w-4 h-4" />
								{{ t('dashboard.automations.detail.edit.empty.addDelay') }}
							</UiButton>
						</div>
					</div>

					<!-- End Node -->
					<div v-if="mutableSteps.length > 0" class="mt-4">
						<div class="card p-4 bg-bg-surface border-dashed">
							<div class="flex items-center justify-center gap-2 text-text-tertiary">
								<Icon name="lucide:check" class="w-5 h-5" />
								<span class="font-medium">{{
									t('dashboard.automations.detail.edit.endOfAutomation')
								}}</span>
							</div>
						</div>
					</div>

					<!-- Validation Warnings (only show for drafts with issues) -->
					<div
						v-if="automation.status === 'draft' && !canActivate.valid"
						class="mt-6 p-4 bg-warning/10 border border-warning/20 rounded-lg"
					>
						<div class="flex items-start gap-3">
							<Icon name="lucide:alert-circle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
							<div class="flex-1 min-w-0">
								<p class="font-medium text-warning mb-2">
									{{ t('dashboard.automations.detail.edit.validation.title') }}
								</p>
								<ul class="list-disc list-inside space-y-1">
									<li
										v-for="(reason, idx) in canActivate.reasons"
										:key="idx"
										class="text-sm text-warning/80"
									>
										{{ reason }}
									</li>
								</ul>
							</div>
						</div>
					</div>
				</div>
			</div>

			<!-- Settings Panel (Right Panel) -->
			<AutomationsStepEditorPanel
				:selected-step="selectedStep"
				:is-saving="isSaving"
				:email-templates="emailTemplates"
				:current-config="currentConfig"
				:mutable-steps="mutableSteps"
				@close="selectedStepId = null"
				@save="handleUpdateStepConfig"
				@delete="handleDeleteStep"
				@update:current-config="currentConfig = $event"
			/>
		</div>

		<!-- Activate Confirmation Modal -->
		<Teleport to="body">
			<Transition
				enter-active-class="transition-opacity duration-(--motion-fast)"
				enter-from-class="opacity-0"
				enter-to-class="opacity-100"
				leave-active-class="transition-opacity duration-(--motion-fast-exit)"
				leave-from-class="opacity-100"
				leave-to-class="opacity-0"
			>
				<div
					v-if="showActivateConfirmModal"
					class="fixed inset-0 z-50 flex items-center justify-center p-4"
				>
					<!-- Backdrop -->
					<div
						class="absolute inset-0 bg-scrim/50 backdrop-blur-sm"
						@click="showActivateConfirmModal = false"
					/>

					<!-- Modal -->
					<div
						class="relative bg-bg-elevated border border-border-subtle rounded-xl shadow-2xl w-full max-w-md"
					>
						<div class="p-6">
							<!-- Icon -->
							<div
								class="w-12 h-12 mx-auto mb-4 rounded-full bg-brand/10 flex items-center justify-center"
							>
								<Icon name="lucide:play" class="w-6 h-6 text-brand" />
							</div>

							<!-- Title -->
							<h3 class="text-lg font-semibold text-text-primary text-center mb-2">
								{{ t('dashboard.automations.detail.edit.activateDialog.title') }}
							</h3>

							<!-- Description -->
							<p class="text-text-secondary text-center mb-6">
								{{ t('dashboard.automations.detail.edit.activateDialog.body') }}
							</p>

							<!-- Summary -->
							<div
								v-if="automation"
								class="bg-bg-surface border border-border-subtle rounded-lg p-4 mb-6"
							>
								<div class="space-y-3">
									<div class="flex items-center justify-between">
										<span class="text-sm text-text-tertiary">{{
											t('dashboard.automations.detail.edit.activateDialog.automation')
										}}</span>
										<span class="text-sm font-medium text-text-primary">{{ automation.name }}</span>
									</div>
									<div class="flex items-center justify-between">
										<span class="text-sm text-text-tertiary">{{
											t('dashboard.automations.detail.edit.trigger')
										}}</span>
										<span class="text-sm font-medium text-text-primary">{{
											t(getTriggerInfo(automation.triggerType).label)
										}}</span>
									</div>
									<div class="flex items-center justify-between">
										<span class="text-sm text-text-tertiary">{{
											t('dashboard.automations.detail.edit.activateDialog.steps')
										}}</span>
										<span class="text-sm font-medium text-text-primary">{{
											t(
												'dashboard.automations.detail.edit.activateDialog.stepCount',
												{ count: mutableSteps.length },
												mutableSteps.length
											)
										}}</span>
									</div>
								</div>
							</div>

							<!-- Buttons -->
							<div class="flex gap-3">
								<UiButton
									variant="secondary"
									class="flex-1"
									@click="showActivateConfirmModal = false"
								>
									{{ t('common.cancel') }}
								</UiButton>
								<UiButton
									class="flex-1 gap-2"
									:disabled="isActivating"
									@click="handleConfirmActivate"
								>
									<Icon v-if="isActivating" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
									<Icon v-else name="lucide:play" class="w-4 h-4" />
									{{
										isActivating
											? t('dashboard.automations.detail.edit.activating')
											: t('dashboard.automations.detail.edit.activate')
									}}
								</UiButton>
							</div>
						</div>
					</div>
				</div>
			</Transition>
		</Teleport>

		<!-- Unsaved Changes Dialog — leaving the page with unsaved step edits -->
		<UnsavedChangesDialog
			:show="showLeaveDialog"
			@close="cancelLeave"
			@discard="confirmLeaveDiscard"
			@save="confirmLeaveSave"
		/>

		<!-- Unsaved Changes Dialog — switching steps with unsaved step edits -->
		<UnsavedChangesDialog
			:show="showStepSwitchDialog"
			@close="cancelStepSwitch"
			@discard="discardStepSwitch"
			@save="saveStepSwitch"
		/>
	</div>
</template>
