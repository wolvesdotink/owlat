import { ref, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { useAutomationSteps } from '~/composables/useAutomationSteps';

type AutomationSteps = ReturnType<typeof useAutomationSteps>;

/**
 * The builder's header actions: Save draft, Pause, Resume and Activate (through
 * its confirmation). Each one waits for the open step's save first, so what
 * gets saved, resumed or activated is what the inspector shows.
 */
export function useAutomationStatusActions(options: {
	automationId: Ref<Id<'automations'>>;
	automation: Ref<{ status: string; name: string; description?: string } | null | undefined>;
	flushStepSave: AutomationSteps['flushStepSave'];
	canActivate: AutomationSteps['canActivate'];
}) {
	const { automationId, automation, flushStepSave, canActivate } = options;
	const { t } = useI18n();

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

	const { showToast } = useToast();

	const isSavingDraft = ref(false);
	const isActivating = ref(false);
	const showActivateConfirmModal = ref(false);
	// The open step's edits could not be saved when activation asked for them, so
	// the modal explains why it did not activate instead of closing.
	const activationSaveFailed = ref(false);

	// Pause or resume. A draft activates through the confirm modal below.
	const handleToggleStatus = async () => {
		if (!automation.value) return;

		isActivating.value = true;

		try {
			if (automation.value.status === 'active') {
				if (!(await pauseAutomation({ automationId: automationId.value })).ok) return;
				showToast(t('dashboard.automations.detail.edit.toasts.paused'));
			} else if (automation.value.status === 'paused') {
				// Resuming runs what is saved, so what is on screen has to be saved first.
				if (!(await flushStepSave())) {
					showToast(t('dashboard.automations.detail.edit.toasts.resumeBlocked'), 'error');
					return;
				}
				if (!(await resumeAutomation({ automationId: automationId.value })).ok) return;
				showToast(t('dashboard.automations.detail.edit.toasts.resumed'));
			}
		} finally {
			isActivating.value = false;
		}
	};

	// Handle save draft: the automation's name and description. Step edits save
	// themselves; Save draft only waits for them, and says so when they did not
	// land rather than reporting a draft that is not what the inspector shows.
	const handleSaveDraft = async () => {
		if (!automation.value) return;

		isSavingDraft.value = true;

		try {
			if (!(await flushStepSave())) {
				showToast(t('dashboard.automations.detail.edit.toasts.stepSaveFailed'), 'error');
				return;
			}
			const result = await updateAutomation({
				automationId: automationId.value,
				name: automation.value.name,
				description: automation.value.description,
			});
			if (!result.ok) return;
			showToast(t('dashboard.automations.detail.edit.toasts.draftSaved'));
		} finally {
			isSavingDraft.value = false;
		}
	};

	const toastCannotActivate = () => {
		showToast(
			canActivate.value.reasons[0] || t('dashboard.automations.detail.edit.cannotActivate'),
			'error'
		);
	};

	// Activation always means "what you see": the open step's edits are saved
	// first, and the readiness check runs on the steps as saved.
	const handleShowActivateConfirm = async () => {
		if (!canActivate.value.valid) return;
		isActivating.value = true;
		let saved: boolean;
		try {
			saved = await flushStepSave();
		} finally {
			isActivating.value = false;
		}
		activationSaveFailed.value = !saved;
		if (saved && !canActivate.value.valid) {
			toastCannotActivate();
			return;
		}
		showActivateConfirmModal.value = true;
	};

	// Confirm activation
	const handleConfirmActivate = async () => {
		if (!automation.value) return;
		isActivating.value = true;
		try {
			// Edits made since the modal opened, or a save that failed before it.
			if (!(await flushStepSave())) {
				activationSaveFailed.value = true;
				return;
			}
			activationSaveFailed.value = false;
			showActivateConfirmModal.value = false;
			if (!canActivate.value.valid) {
				toastCannotActivate();
				return;
			}
			if (!(await activateAutomation({ automationId: automationId.value })).ok) return;
			showToast(t('dashboard.automations.detail.edit.toasts.activated'));
		} finally {
			isActivating.value = false;
		}
	};

	return {
		isSavingDraft,
		isActivating,
		showActivateConfirmModal,
		activationSaveFailed,
		handleToggleStatus,
		handleSaveDraft,
		handleShowActivateConfirm,
		handleConfirmActivate,
	};
}
