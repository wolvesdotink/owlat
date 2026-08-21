import { ref, computed, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id, Doc } from '@owlat/api/dataModel';
import type { TriggerConfig } from '../../../api/convex/lib/automationConfigTypes';
import { useAutomationStepConfig } from './useAutomationStepConfig';
import { listStepEditorModules, stepEditorModuleFor, type StepKind } from './automations/steps';
import type { StepMessage } from './automations/steps/types';
import { useAutomationPluginPalette } from './automations/pluginPalette';

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
	const { t } = useI18n();

	const { run: addStepMutation } = useBackendOperation(api.automations.steps.addStep, {
		label: () => t('shared.useAutomationSteps.addStepOperation'),
	});
	const { run: removeStepMutation } = useBackendOperation(api.automations.steps.removeStep, {
		label: () => t('shared.useAutomationSteps.deleteStepOperation'),
	});
	const { run: reorderStepsMutation } = useBackendOperation(api.automations.steps.reorderSteps, {
		label: () => t('shared.useAutomationSteps.reorderStepsOperation'),
	});

	const { showToast } = useToast();

	// A step editor module hands back message KEYS (it is module scope and cannot
	// translate); the builder is what renders them, so it resolves them here.
	const translateStepMessage = (message: StepMessage): string =>
		typeof message === 'string' ? t(message) : t(message.key, message.params ?? {});

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

	// Host-composed plugin step kinds, surfaced from the generated editor metadata
	// catalog so the builder can list plugin contributions alongside core steps.
	// Empty until a bundled plugin contributes an automation step.
	const pluginStepTypes = computed(() =>
		useAutomationPluginPalette().steps.map((entry) => ({
			id: entry.kind,
			label: entry.label,
			description: entry.description,
			icon: entry.icon,
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
		return translateStepMessage(
			(
				module.getDescription as (
					c: unknown,
					ctx: { emailTemplates: Doc<'emailTemplates'>[] }
				) => StepMessage
			)(config, { emailTemplates: emailTemplates.value ?? [] })
		);
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

		showToast(t('shared.useAutomationSteps.stepAdded', { step: t(module.label) }));
	};

	const handleDeleteStep = async (stepId: Id<'automationSteps'>) => {
		const result = await removeStepMutation({ stepId });
		if (result === undefined) return;
		if (selectedStepId.value === stepId) {
			selectedStepId.value = null;
		}
		showToast(t('shared.useAutomationSteps.stepDeleted'));
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
		if (!automation.value) {
			return {
				valid: false,
				reasons: [t('shared.useAutomationSteps.validation.automationNotLoaded')],
			};
		}

		const reasons: string[] = [];

		if (!mutableSteps.value.length) {
			reasons.push(t('shared.useAutomationSteps.validation.addStep'));
		}

		if (automation.value.triggerType === 'contact_updated' && !automation.value.triggerConfig) {
			reasons.push(t('shared.useAutomationSteps.validation.contactUpdatedTrigger'));
		}
		if (automation.value.triggerType === 'event_received' && !automation.value.triggerConfig) {
			reasons.push(t('shared.useAutomationSteps.validation.eventReceivedTrigger'));
		}
		if (automation.value.triggerType === 'topic_subscribed' && !automation.value.triggerConfig) {
			reasons.push(t('shared.useAutomationSteps.validation.topicSubscribedTrigger'));
		}

		for (let i = 0; i < mutableSteps.value.length; i++) {
			const step = mutableSteps.value[i];
			if (!step) continue;
			const kind = step.stepType as StepKind;
			const module = stepEditorModuleFor(kind);
			const config = module.parseConfig(stepConfig.parseStepConfig(step));
			const error = (
				module.validateForActivation as (
					c: unknown,
					ctx: { stepCount: number }
				) => StepMessage | null
			)(config, { stepCount: mutableSteps.value.length });
			if (error) {
				reasons.push(
					t('shared.useAutomationSteps.validation.stepReason', {
						index: i + 1,
						reason: translateStepMessage(error),
					})
				);
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
		pluginStepTypes,
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
