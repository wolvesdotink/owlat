import { ref, computed, watch, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id, Doc } from '@owlat/api/dataModel';
import { stepEditorModuleFor, type StepConfigByKind, type StepKind } from './automations/steps';

interface AutomationWithSteps {
	steps?: Doc<'automationSteps'>[];
}

export type StepCurrentConfig =
	| { kind: 'email'; config: StepConfigByKind['email'] }
	| { kind: 'delay'; config: StepConfigByKind['delay'] }
	| { kind: 'condition'; config: StepConfigByKind['condition'] }
	| null;

/**
 * Where the open step's edits stand. `saved` means the inspector shows exactly
 * what the server holds; `conflict` means the server copy changed under an
 * unsaved local edit and the member has to pick one.
 */
export type StepSaveStatus = 'saved' | 'saving' | 'error' | 'conflict';

function parseStepConfigRaw(step: Doc<'automationSteps'>): unknown {
	if (typeof step.config === 'object' && step.config !== null) return step.config;
	try {
		return JSON.parse(step.config as string);
	} catch {
		return {};
	}
}

/**
 * JSON with object keys sorted, so two configs that hold the same values
 * compare equal however their keys were ordered (an editor spreads the old
 * config and appends the changed field; the server echo is re-parsed).
 */
function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.fromEntries(
					Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
				)
			: v
	);
}

function parseStep(step: Doc<'automationSteps'>): NonNullable<StepCurrentConfig> {
	const kind = step.stepType as StepKind;
	return {
		kind,
		config: stepEditorModuleFor(kind).parseConfig(parseStepConfigRaw(step)),
	} as NonNullable<StepCurrentConfig>;
}

/**
 * Manages the currently-edited step's typed config and its autosave.
 *
 * The editor exposes one discriminated `currentConfig` keyed by the
 * selected step's `kind`. Per-kind editor knowledge lives in
 * `composables/automations/steps/<kind>/` — this composable is a thin
 * walker over that registry.
 *
 * Autosave is the only save model: every step editor emits `save` on change,
 * and `requestSave` persists it. Saves for the open step run one at a time;
 * an edit made while one is in flight is sent once that one lands, so several
 * quick edits coalesce into at most one follow-up request. Each request
 * carries the config as it was when it was SENT, and only that snapshot
 * becomes the clean baseline — an edit made during the request stays dirty.
 */
export function useAutomationStepConfig(
	selectedStepId: Ref<Id<'automationSteps'> | null>,
	automation: Ref<AutomationWithSteps | null | undefined>
) {
	const { t } = useI18n();

	// Autosave runs on every change, so the success announcement would talk
	// over the editor; the status line (a polite live region) speaks instead.
	const { run: updateStepMutation } = useBackendOperation(api.automations.steps.updateStep, {
		label: () => t('shared.useAutomationStepConfig.updateStepOperation'),
		announce: false,
	});

	const currentConfig = ref<StepCurrentConfig>(null);

	// The selected step's config as last derived from (or persisted to) the
	// server, serialized for cheap comparison. `currentConfig` diverging from
	// this is what "unsaved step edits" means.
	const persistedConfigJson = ref<string | null>(null);

	// The snapshot of the request in flight, so its own echo through the live
	// query is recognised as ours rather than as a change made elsewhere.
	let inFlightJson: string | null = null;
	let inFlight: Promise<boolean> | null = null;
	const isSaving = ref(false);
	const saveFailed = ref(false);

	// The server copy that arrived while the open draft held unsaved edits.
	const remoteConfig = ref<NonNullable<StepCurrentConfig> | null>(null);

	const currentJson = () => (currentConfig.value ? stableJson(currentConfig.value.config) : null);

	const isCurrentConfigDirty = computed(() => {
		if (!currentConfig.value || persistedConfigJson.value === null) return false;
		return stableJson(currentConfig.value.config) !== persistedConfigJson.value;
	});

	const seed = (parsed: NonNullable<StepCurrentConfig> | null) => {
		currentConfig.value = parsed;
		persistedConfigJson.value = parsed ? stableJson(parsed.config) : null;
		remoteConfig.value = null;
		saveFailed.value = false;
	};

	const selectedServerStep = computed(() => {
		const id = selectedStepId.value;
		if (!id) return null;
		return automation.value?.steps?.find((s) => s._id === id) ?? null;
	});

	// Re-seed only when the selection changes. Live updates to OTHER steps (a
	// reorder, a colleague editing step 4) never touch the open draft.
	watch(
		selectedStepId,
		() => {
			const step = selectedServerStep.value;
			seed(step ? parseStep(step) : null);
		},
		{ immediate: true }
	);

	// The selected step's own server copy. Adopted while the draft is clean;
	// held as a conflict while it is dirty, so a local edit is never
	// overwritten silently.
	const selectedServerJson = computed(() => {
		const step = selectedServerStep.value;
		return step ? stableJson(parseStep(step).config) : null;
	});
	watch(selectedServerJson, (serverJson) => {
		const step = selectedServerStep.value;
		if (!step || serverJson === null) {
			// The selected step was deleted elsewhere.
			if (selectedStepId.value) seed(null);
			return;
		}
		if (currentConfig.value === null) {
			// The step was selected before the automation loaded.
			seed(parseStep(step));
			return;
		}
		// The server holds what we last saved, or what we are saving now (our
		// own request, reflected back before its promise settled). Any other
		// copy seen in between has been overwritten by ours.
		if (serverJson === persistedConfigJson.value || serverJson === inFlightJson) {
			persistedConfigJson.value = serverJson;
			remoteConfig.value = null;
			return;
		}
		if (!isCurrentConfigDirty.value) {
			seed(parseStep(step));
			return;
		}
		if (serverJson === currentJson()) {
			// Someone else saved exactly what is on screen.
			persistedConfigJson.value = serverJson;
			remoteConfig.value = null;
			return;
		}
		remoteConfig.value = parseStep(step);
	});

	const runSaves = async (): Promise<boolean> => {
		isSaving.value = true;
		try {
			while (isCurrentConfigDirty.value && remoteConfig.value === null) {
				const stepId = selectedStepId.value;
				const snapshot = currentJson();
				if (!stepId || snapshot === null) return true;
				inFlightJson = snapshot;
				const result = await updateStepMutation({
					stepId,
					config: JSON.parse(snapshot) as never,
				});
				inFlightJson = null;
				// The selection moved while the request ran: nothing of this
				// request's result belongs to the step now on screen.
				if (selectedStepId.value !== stepId) return result.ok;
				if (!result.ok) {
					saveFailed.value = true;
					return false;
				}
				saveFailed.value = false;
				persistedConfigJson.value = snapshot;
			}
			// A conflict stops the queue: nothing is saved over the other copy
			// until the member chooses.
			return remoteConfig.value === null;
		} finally {
			inFlightJson = null;
			isSaving.value = false;
		}
	};

	/**
	 * Persist the open step's edits. Joins the request already running rather
	 * than starting a second one for the same step; that request picks up any
	 * newer edit before it settles. Resolves `true` once everything on screen
	 * is saved.
	 */
	const requestSave = (): Promise<boolean> => {
		if (inFlight) return inFlight;
		if (!isCurrentConfigDirty.value) return Promise.resolve(remoteConfig.value === null);
		if (remoteConfig.value !== null) return Promise.resolve(false);
		inFlight = runSaves().finally(() => {
			inFlight = null;
		});
		return inFlight;
	};

	/**
	 * Wait for the open step to be fully saved before something that depends
	 * on it (closing the inspector, activation). Resolves `false` when it
	 * could not be saved; the edits stay on screen.
	 */
	const flush = async (): Promise<boolean> => {
		// A request already running is the attempt; its failure is the answer.
		if (inFlight && !(await inFlight)) return false;
		return requestSave();
	};

	/** Throw the local edits away and show the server copy again. */
	const discardChanges = () => {
		const step = selectedServerStep.value;
		seed(step ? parseStep(step) : null);
	};

	/** Conflict: take the copy that was saved elsewhere. */
	const takeRemoteConfig = () => {
		if (remoteConfig.value) seed(remoteConfig.value);
	};

	/** Conflict: keep the local draft and save it over the other copy. */
	const keepLocalConfig = (): Promise<boolean> => {
		const remote = remoteConfig.value;
		if (!remote) return requestSave();
		persistedConfigJson.value = stableJson(remote.config);
		remoteConfig.value = null;
		return requestSave();
	};

	const saveStatus = computed<StepSaveStatus>(() => {
		if (remoteConfig.value) return 'conflict';
		if (isSaving.value) return 'saving';
		if (saveFailed.value && isCurrentConfigDirty.value) return 'error';
		return 'saved';
	});

	return {
		isSaving,
		saveStatus,
		currentConfig,
		isCurrentConfigDirty,
		hasRemoteChange: computed(() => remoteConfig.value !== null),
		parseStepConfig: parseStepConfigRaw,
		requestSave,
		flush,
		discardChanges,
		takeRemoteConfig,
		keepLocalConfig,
	};
}
