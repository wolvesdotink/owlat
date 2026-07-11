import { ref, computed, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id, Doc } from '@owlat/api/dataModel';
import type { TriggerConfig } from '../../../api/convex/lib/automationConfigTypes';
import { useAutomationStepConfig } from './useAutomationStepConfig';
import { listStepEditorModules, stepEditorModuleFor, type StepKind } from './automations/steps';

interface AutomationWithSteps {
	_id: Id<'automations'>;
	name: string;
	description?: string;
	status: string;
	triggerType: string;
	triggerConfig?: TriggerConfig;
	topic?: Doc<'topics'> | null;
	steps?: (Doc<'automationSteps'> & { emailTemplate?: Doc<'emailTemplates'> | null })[];
}

export function useAutomationSteps(
	automationId: Ref<Id<'automations'>>,
	automation: Ref<AutomationWithSteps | null | undefined>,
	emailTemplates: Ref<Doc<'emailTemplates'>[] | null | undefined>
) {
	const { run: addStepMutation } = useBackendOperation(api.automations.steps.addStep, {
		label: 'Add automation step',
	});
	const { run: removeStepMutation } = useBackendOperation(api.automations.steps.removeStep, {
		label: 'Delete automation step',
	});
	const { run: reorderStepsMutation } = useBackendOperation(api.automations.steps.reorderSteps, {
		label: 'Reorder automation steps',
	});

	const { showToast } = useToast();

	const isAddStepDropdownOpen = ref(false);
	const addStepDropdownIndex = ref<number | null>(null);
	const selectedStepId = ref<Id<'automationSteps'> | null>(null);

	// Step kind catalog — derived from the editor module registry.
	const stepTypes = computed(() =>
		listStepEditorModules().map((m) => ({
			id: m.kind,
			label: m.label,
			description: m.description,
			color: m.color,
			icon: m.icon,
		}))
	);

	const mutableSteps = computed(() => {
		if (!automation.value?.steps) return [];
		return [...automation.value.steps];
	});

	const selectedStep = computed(() => {
		if (!selectedStepId.value || !automation.value?.steps) return null;
		return automation.value.steps.find((s) => s._id === selectedStepId.value) || null;
	});

	const stepConfig = useAutomationStepConfig(selectedStepId, automation, showToast);

	// ─── Description Helpers (delegated to per-kind editor modules) ────

	const getStepDescription = (
		step: Doc<'automationSteps'> & { emailTemplate?: Doc<'emailTemplates'> | null }
	): string => {
		const kind = step.stepType as StepKind;
		const module = stepEditorModuleFor(kind);
		const config = module.parseConfig(stepConfig.parseStepConfig(step));
		if (kind === 'email' && step.emailTemplate) {
			return step.emailTemplate.name;
		}
		return (
			module.getDescription as (
				c: unknown,
				ctx: { emailTemplates: Doc<'emailTemplates'>[] }
			) => string
		)(config, { emailTemplates: emailTemplates.value ?? [] });
	};

	const handleAddStep = async (stepType: StepKind, insertAtIndex?: number) => {
		if (!automation.value) return;

		isAddStepDropdownOpen.value = false;
		addStepDropdownIndex.value = null;

		const module = stepEditorModuleFor(stepType);
		const config = module.createDefault();

		const stepId = await addStepMutation({
			automationId: automationId.value,
			stepType,
			config: config as never,
			insertAtIndex,
		});
		if (stepId === undefined) return;

		if (stepId) {
			selectedStepId.value = stepId;
		}

		showToast(`${module.label} step added`);
	};

	const handleDeleteStep = async (stepId: Id<'automationSteps'>) => {
		const result = await removeStepMutation({ stepId });
		if (result === undefined) return;
		if (selectedStepId.value === stepId) {
			selectedStepId.value = null;
		}
		showToast('Step deleted');
	};

	// VueDraggable binds `:model-value` one-way, so the dragged order lives only
	// in the SortableJS `@end` event (oldIndex/newIndex) — `automation.steps` is
	// still the un-reordered server order. Apply the move to the id list before
	// persisting, otherwise the reorder is a silent no-op.
	const handleDragEnd = async (event?: { oldIndex?: number | null; newIndex?: number | null }) => {
		if (!automation.value?.steps) return;
		const oldIndex = event?.oldIndex;
		const newIndex = event?.newIndex;
		if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
		const stepOrder = automation.value.steps.map((step) => step._id);
		if (
			oldIndex < 0 ||
			oldIndex >= stepOrder.length ||
			newIndex < 0 ||
			newIndex >= stepOrder.length
		) {
			return;
		}
		const [moved] = stepOrder.splice(oldIndex, 1);
		if (moved === undefined) return;
		stepOrder.splice(newIndex, 0, moved);
		await reorderStepsMutation({
			automationId: automationId.value,
			stepOrder,
		});
	};

	// ─── Validation (per-step delegated to editor modules) ──────────────

	const canActivate = computed(() => {
		if (!automation.value) return { valid: false, reasons: ['Automation not loaded'] };

		const reasons: string[] = [];

		if (!mutableSteps.value.length) {
			reasons.push('Add at least one step to the workflow');
		}

		if (automation.value.triggerType === 'contact_updated' && !automation.value.triggerConfig) {
			reasons.push('Contact Updated trigger requires a property to watch');
		}
		if (automation.value.triggerType === 'event_received' && !automation.value.triggerConfig) {
			reasons.push('Event Received trigger requires an event name');
		}
		if (automation.value.triggerType === 'topic_subscribed' && !automation.value.triggerConfig) {
			reasons.push('Topic Subscribed trigger requires a topic selection');
		}

		for (let i = 0; i < mutableSteps.value.length; i++) {
			const step = mutableSteps.value[i];
			if (!step) continue;
			const kind = step.stepType as StepKind;
			const module = stepEditorModuleFor(kind);
			const config = module.parseConfig(stepConfig.parseStepConfig(step));
			const error = (
				module.validateForActivation as (c: unknown, ctx: { stepCount: number }) => string | null
			)(config, { stepCount: mutableSteps.value.length });
			if (error) {
				reasons.push(`Step ${i + 1}: ${error}`);
			}
		}

		return { valid: reasons.length === 0, reasons };
	});

	const closeDropdowns = () => {
		isAddStepDropdownOpen.value = false;
		addStepDropdownIndex.value = null;
	};

	return {
		isSaving: stepConfig.isSaving,
		isAddStepDropdownOpen,
		addStepDropdownIndex,
		selectedStepId,
		selectedStep,
		mutableSteps,
		stepTypes,
		canActivate,

		currentConfig: stepConfig.currentConfig,
		isCurrentConfigDirty: stepConfig.isCurrentConfigDirty,

		handleAddStep,
		handleDeleteStep,
		handleDragEnd,
		handleUpdateStepConfig: stepConfig.handleUpdateStepConfig,
		closeDropdowns,

		parseStepConfig: stepConfig.parseStepConfig,
		getStepDescription,
	};
}
