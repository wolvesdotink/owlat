<script setup lang="ts">
import { VueDraggable } from 'vue-draggable-plus';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { computed } from 'vue';
import { provideConditionEditorContext } from '~/composables/conditions';
import type { StepKind } from '~/composables/automations/steps';
import { useAutomationStatusActions } from '~/composables/automations/useAutomationStatusActions';
import { useKeyboardReorder } from '~/composables/automations/useKeyboardReorder';
import { useStepExit } from '~/composables/automations/useStepExit';
import { useStepOrderSync } from '~/composables/automations/useStepOrderSync';
import { useRecordPaletteObjectOpen } from '~/composables/useCommandPaletteObjectRecents';
import ActivateConfirmModal from '~/components/automations/editor/ActivateConfirmModal.vue';
import ActivationIssues from '~/components/automations/editor/ActivationIssues.vue';
import AddStepMenu from '~/components/automations/editor/AddStepMenu.vue';
import EditorHeader from '~/components/automations/editor/EditorHeader.vue';
import EditorProgress from '~/components/automations/editor/EditorProgress.vue';
import EmptySteps from '~/components/automations/editor/EmptySteps.vue';
import StepCard from '~/components/automations/editor/StepCard.vue';
import TriggerNode from '~/components/automations/editor/TriggerNode.vue';

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
const {
	data: automation,
	isLoading: isLoadingAutomation,
	error: automationError,
	refetch: refetchAutomation,
} = useConvexQuery(api.automations.automations.getWithRelations, () => ({
	automationId: automationId.value,
}));
useRecordPaletteObjectOpen(() =>
	automation.value?.name
		? { kind: 'automation', id: automationId.value, title: automation.value.name }
		: null
);

// Fetch email templates for email step selection (marketing templates can be used in automations)
const { results: emailTemplates } = usePaginatedQuery(
	api.emailTemplates.emails.list,
	() => ({ type: 'marketing' as const }),
	{ initialNumItems: 100 }
);

// Fetch contact properties for condition step configuration
const { data: contactProperties } = useOrganizationQuery(
	api.contacts.properties.listByOrganization
);

// Fetch topics for condition step configuration
const { results: topics } = useTopicsList();

// Use automation steps composable
const {
	// State
	stepSaveStatus,
	isAddStepDropdownOpen,
	addStepDropdownIndex,
	selectedStepId,
	selectedStep,
	mutableSteps,
	stepTypes,
	canActivate,
	currentConfig,
	isCurrentConfigDirty,
	hasRemoteStepChange,

	// Methods
	handleAddStep,
	handleDeleteStep,
	persistStepOrder,
	requestStepSave,
	flushStepSave,
	discardStepChanges,
	takeRemoteStepConfig,
	keepLocalStepConfig,
	closeDropdowns,

	// Description helper
	getStepDescription,
} = useAutomationSteps(automationId, automation, emailTemplates);

// Save draft, Pause, Resume and Activate, each after the open step's save.
const {
	isSavingDraft,
	isActivating,
	showActivateConfirmModal,
	activationSaveFailed,
	handleToggleStatus,
	handleSaveDraft,
	handleShowActivateConfirm,
	handleConfirmActivate,
} = useAutomationStatusActions({ automationId, automation, flushStepSave, canActivate });

// Leaving the open step waits for its save; a failed save asks first.
const {
	pendingStepExit,
	isRetryingStepExit,
	afterStepSaved,
	retryStepExit,
	discardStepExit,
	stayOnStep,
} = useStepExit({
	flushStepSave,
	hasRemoteStepChange,
	keepLocalStepConfig,
	takeRemoteStepConfig,
	discardStepChanges,
});

// The add-step mutation in flight, if any. See `requestAddStep`.
let stepAdding: Promise<unknown> = Promise.resolve();
// The list the drag handle reorders. VueDraggable writes the new order back
// through v-model the moment an item is dropped, and the keyboard and the
// step menu move it the same way; every route then commits the order shown,
// so what runs is what the user sees. A lifted keyboard step is only a
// preview until it is dropped. See `useStepOrderSync` for how commits made
// while a save is in flight are queued.
const stepOrder = useStepOrderSync({
	server: mutableSteps,
	save: (ids) => persistStepOrder(ids as Id<'automationSteps'>[]),
	// The open step's save lands first, like every other change to the
	// workflow's shape, and so does a step being added: the order sent must
	// include it.
	whenReady: (proceed, cancel) =>
		afterStepSaved(async () => {
			await stepAdding;
			await proceed();
		}, cancel),
	isPreviewing: (): boolean => keyboardReorder.liftedId.value !== null,
	// A failed save shows the server's order, so a lift on top of it is gone.
	onReplaced: (): void => keyboardReorder.reset(),
});
const orderedSteps = stepOrder.items;
const persistDisplayedOrder = (onSaved?: () => void): Promise<void> => stepOrder.persist(onSaved);
// A pointer drag starts from the committed order, not from a keyboard lift.
function onStepDragStart(): void {
	keyboardReorder.cancel({ refocusHandle: false });
}
function onStepDragEnd() {
	return persistDisplayedOrder();
}

// Keyboard and screen-reader route to the same reorder: the step title is the
// button that opens a step, the handle is the button that moves it.
const { announce } = useAnnounce();
const stepControl = (stepId: string, control: 'title' | 'handle') =>
	document.querySelector<HTMLElement>(`[data-step-${control}="${stepId}"]`);
const focusStepControl = (stepId: string, control: 'title' | 'handle') => {
	stepControl(stepId, control)?.focus();
};
const positionMessage =
	(key: string) =>
	(position: number, total: number): string =>
		t(key, { position, total });
const keyboardReorder = useKeyboardReorder({
	items: orderedSteps,
	restore: () => stepOrder.showCommitted(),
	commit: (onSaved) => persistDisplayedOrder(onSaved),
	handleElement: (id) => stepControl(id, 'handle'),
	focusHandle: (id) => focusStepControl(id, 'handle'),
	announce,
	messages: {
		pickedUp: positionMessage('dashboard.automations.detail.edit.reorder.pickedUp'),
		moved: positionMessage('dashboard.automations.detail.edit.reorder.position'),
		dropped: positionMessage('dashboard.automations.detail.edit.reorder.dropped'),
		cancelled: positionMessage('dashboard.automations.detail.edit.reorder.cancelled'),
	},
});
// Opening a step in the inspector (or closing it) ends a lift.
watch(selectedStepId, () => keyboardReorder.cancel({ refocusHandle: false }));
const liftedStepId = keyboardReorder.liftedId;
// Move up / Move down from the step's actions menu, for anyone who does not
// know the handle works from the keyboard. Focus stays on the moved step.
const moveStepBy = (stepId: string, delta: -1 | 1) => {
	keyboardReorder.cancel({ refocusHandle: false });
	const from = orderedSteps.value.findIndex((step) => step._id === stepId);
	const to = from + delta;
	if (from === -1 || to < 0 || to >= orderedSteps.value.length) return;
	const next = [...orderedSteps.value];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved!);
	orderedSteps.value = next;
	void nextTick(() => focusStepControl(stepId, 'title'));
	return persistDisplayedOrder(() =>
		announce(
			positionMessage('dashboard.automations.detail.edit.reorder.dropped')(to + 1, next.length)
		)
	);
};
const openStepMenuId = ref<string | null>(null);

// Below `lg` the inspector is a sheet over the page, so what it covers leaves
// the tab order until it closes.
const isWideViewport = useMediaQuery('(min-width: 1024px)');
const isInspectorOverlay = computed(() => selectedStep.value !== null && !isWideViewport.value);

// Provide reference data to descendant Condition editor modules
provideConditionEditorContext({ contactProperties, topics });

// Navigate back once the open step's save has landed. If it could not be saved,
// `router.push` hits the unsaved-changes route guard below, which prompts
// instead of dropping the edits.
const handleBack = async () => {
	await flushStepSave();
	router.push('/dashboard/automations');
};

// Unsaved-changes guard for the open step panel. Leaving the page (Back, the
// trigger "Edit" link, or any in-app navigation) while the panel holds edits
// prompts to save/discard. Reuses the shared composable + dialog. `onSave`
// persists the open step config before navigating.
const {
	showDialog: showLeaveDialog,
	isSavingBeforeLeave,
	confirmDiscard: confirmLeaveDiscard,
	confirmSave: confirmLeaveSave,
	cancelNavigation: cancelLeave,
	setHasChanges,
} = useUnsavedChanges({
	onSave: async () => {
		// A failed step-config save keeps the panel dirty; throw so the guard
		// stays put instead of clearing the flag and navigating away — mirrors
		// the step-exit guard and the campaign/settings surfaces.
		if (!(await flushStepSave())) throw new Error('Save failed');
	},
});
watch(isCurrentConfigDirty, (dirty) => setHasChanges(dirty), { immediate: true });

const requestSelectStep = (stepId: Id<'automationSteps'>) => {
	if (stepId === selectedStepId.value) return;
	return afterStepSaved(() => {
		selectedStepId.value = stepId;
	});
};
// Focus goes back to the step's title, so a keyboard user carries on from the
// step they just edited instead of from the top of the page.
const closeInspector = () =>
	afterStepSaved(async () => {
		const stepId = selectedStepId.value;
		selectedStepId.value = null;
		await nextTick();
		if (stepId) focusStepControl(stepId, 'title');
	});
// `insertAtIndex` is a position on screen, which the server only shares once
// queued reorders are saved. Wait for them, then insert after the same step.
const requestAddStep = (stepType: StepKind, insertAtIndex?: number) => {
	closeDropdowns();
	const afterStepId = insertAtIndex ? orderedSteps.value[insertAtIndex - 1]?._id : undefined;
	return afterStepSaved(async () => {
		await stepOrder.settled();
		let index = insertAtIndex;
		if (afterStepId) {
			const anchor = orderedSteps.value.findIndex((step) => step._id === afterStepId);
			if (anchor !== -1) index = anchor + 1;
		}
		stepAdding = handleAddStep(stepType, index);
		await stepAdding;
	});
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
		<EditorHeader
			:inert="isInspectorOverlay || undefined"
			:automation="automation"
			:is-loading="isLoadingAutomation"
			:step-save-status="stepSaveStatus"
			:is-saving-draft="isSavingDraft"
			:is-activating="isActivating"
			:can-activate="canActivate"
			@back="handleBack"
			@retry-step-save="requestStepSave"
			@save-draft="handleSaveDraft"
			@toggle-status="handleToggleStatus"
			@activate="handleShowActivateConfirm"
		/>

		<!-- Progress Indicator -->
		<EditorProgress :inert="isInspectorOverlay || undefined" />

		<!-- A failed read is not a missing automation. -->
		<div v-if="automationError" class="flex-1 flex items-center justify-center">
			<UiQueryBoundary :error="automationError" @retry="refetchAutomation" />
		</div>

		<!-- Loading State -->
		<div v-else-if="isLoadingAutomation" class="flex-1 flex items-center justify-center">
			<UiSpinner delay />
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

		<!-- Main Content: the canvas, plus the step inspector while a step is open -->
		<!-- overflow-clip, not -hidden: a scroll container here would pin the step
		     panel's sticky content to this box instead of the viewport. -->
		<div v-else class="flex-1 flex overflow-clip">
			<!-- Workflow Canvas -->
			<div
				class="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6"
				:inert="isInspectorOverlay || undefined"
			>
				<div class="max-w-xl mx-auto">
					<!-- Trigger Node -->
					<TriggerNode
						:automation="automation"
						:topics="topics"
						:add-step-open="addStepDropdownIndex === -1"
						:step-types="stepTypes"
						@toggle-add-step="addStepDropdownIndex = addStepDropdownIndex === -1 ? null : -1"
						@add-step="requestAddStep($event, 0)"
					/>

					<!-- Steps List -->
					<p id="step-reorder-instructions" class="sr-only">
						{{ t('dashboard.automations.detail.edit.reorder.instructions') }}
					</p>
					<!-- vue-draggable-plus renders only its default slot: the rows are a
						plain v-for inside it (the old vuedraggable `#item` slot is ignored). -->
					<VueDraggable
						v-if="orderedSteps.length > 0"
						v-model="orderedSteps"
						handle=".drag-handle"
						ghost-class="opacity-50"
						@start="onStepDragStart"
						@end="onStepDragEnd"
					>
						<div
							v-for="(step, index) in orderedSteps"
							:key="step._id"
							class="relative"
							data-testid="automation-step"
						>
							<StepCard
								:step="step"
								:index="index"
								:total="orderedSteps.length"
								:selected="selectedStepId === step._id"
								:lifted="liftedStepId === step._id"
								:menu-open="openStepMenuId === step._id"
								:description="getStepDescription(step)"
								@select="requestSelectStep(step._id)"
								@handle-keydown="keyboardReorder.onKeydown($event, step._id)"
								@update:menu-open="openStepMenuId = $event ? step._id : null"
								@move="moveStepBy(step._id, $event)"
								@delete="handleDeleteStep(step._id)"
							/>

							<!-- Connector Line -->
							<div class="flex flex-col items-center">
								<div class="w-0.5 h-4 bg-border-default" />

								<!-- Add Step Button (after this step) -->
								<AddStepMenu
									:open="addStepDropdownIndex === index"
									:step-types="stepTypes"
									menu-test-id="add-step-menu"
									@toggle="addStepDropdownIndex = addStepDropdownIndex === index ? null : index"
									@add="requestAddStep($event, index + 1)"
								/>

								<div v-if="index < orderedSteps.length - 1" class="w-0.5 h-4 bg-border-default" />
							</div>
						</div>
					</VueDraggable>

					<!-- Empty State - No Steps -->
					<EmptySteps v-else @add="requestAddStep" />

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
					<ActivationIssues
						v-if="automation.status === 'draft' && !canActivate.valid"
						:reasons="canActivate.reasons"
					/>
				</div>
			</div>

			<!-- Step inspector: a column at lg, a sheet below it -->
			<AutomationsStepEditorPanel
				v-if="selectedStep"
				:selected-step="selectedStep"
				:save-status="stepSaveStatus"
				:email-templates="emailTemplates"
				:current-config="currentConfig"
				:mutable-steps="mutableSteps"
				@close="closeInspector"
				@save="requestStepSave"
				@retry="requestStepSave"
				@use-theirs="takeRemoteStepConfig"
				@keep-mine="keepLocalStepConfig"
				@delete="handleDeleteStep"
				@update:current-config="currentConfig = $event"
			/>
		</div>

		<!-- Activate Confirmation Modal -->
		<ActivateConfirmModal
			:open="showActivateConfirmModal"
			:automation="automation"
			:step-count="mutableSteps.length"
			:is-activating="isActivating"
			:save-failed="activationSaveFailed"
			@close="showActivateConfirmModal = false"
			@confirm="handleConfirmActivate"
		/>

		<!-- Unsaved Changes Dialog — leaving the page with unsaved step edits -->
		<UiUnsavedChangesDialog
			:show="showLeaveDialog"
			:saving="isSavingBeforeLeave"
			@close="cancelLeave"
			@discard="confirmLeaveDiscard"
			@save="confirmLeaveSave"
		/>

		<!-- Leaving a step whose save failed, or that changed elsewhere -->
		<AutomationsStepSaveFailedDialog
			:open="pendingStepExit !== null"
			:conflict="hasRemoteStepChange"
			:retrying="isRetryingStepExit"
			@retry="retryStepExit"
			@discard="discardStepExit"
			@stay="stayOnStep"
		/>
	</div>
</template>
