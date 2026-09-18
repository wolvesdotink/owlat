import { computed, reactive, ref, watch } from 'vue';
import type { BackendOperationResult } from './useBackendOperation';
import {
	decisionProviderMeta,
	decisionProviderOptions,
	modelOptions,
	resolveModelId,
	testConnectionReducer,
	type DecisionProviderKind,
	type TestConnectionState,
} from '~/utils/aiProviders';
import {
	DECISION_FALLBACK_SURFACES,
	DECISION_THRESHOLDS,
	DEFAULT_DECISION_KIND,
	SETUP_DEFAULT_DECISION_KIND,
	areDecisionThresholdsInert,
	decisionConsentOwed,
	decisionDegradedReasons,
	decisionEndpointHost,
	decisionKeyNotice,
	shouldSendDecisionConfig,
	validateDecisionConfig,
	type DecisionFormSnapshot,
} from '~/utils/aiDecisionPlane';

/**
 * The DECISION plane's half of the AI-provider form — the third card's state,
 * hydration, consent gate, save arguments and connection test.
 *
 * A sibling of `useAiProviderForm` rather than more of it, for the same reason
 * the backend gave the plane its own resolver: the language/embedding form is
 * already at the file-size cap, and this half has rules of its own (a consent
 * gate, a degraded state, an off-switch that has to travel as an explicit
 * `'llm'`) that are worth reading and testing without the other two planes in
 * the way. The pure rules are one layer further down in
 * `utils/aiDecisionPlane.ts`; this file is the reactive wiring.
 *
 * THE INVARIANT: an install that never opted in must save exactly what it saved
 * before. {@link decisionSaveArgs} returns an EMPTY object in that case, and
 * `aiProviderConfigActions.saveConfig` reads an absent `decisionProviderKind` as
 * "leave the plane alone" — not as a clear. So the language card can be edited
 * and saved all day without touching, enabling or erasing anything here.
 */

/** The decision fields of `aiProviderConfig.getConfig`, structurally. */
export interface StoredDecisionConfig {
	configured?: boolean;
	decisionProviderKind?: DecisionProviderKind;
	decisionModel?: string;
	decisionBaseUrl?: string;
	isDecisionFallbackEnabled?: boolean;
	isDecisionKeySet?: boolean;
	decisionKeyPreview?: string;
}

/** The decision arguments of `saveConfig`, all optional and all-or-nothing. */
export interface DecisionSaveArgs {
	decisionProviderKind?: DecisionProviderKind;
	decisionModel?: string;
	decisionBaseUrl?: string;
	isDecisionFallbackEnabled?: boolean;
	decisionApiKey?: string;
}

export interface UseAiDecisionPlaneOptions {
	/** Reader for the stored config — an accessor, so the ref stays the parent's. */
	config: () => StoredDecisionConfig | null | undefined;
	/** `aiProviderConfigActions.testConnection`, bound by the parent. */
	runTest: (args: {
		plane: 'decision';
	}) => Promise<BackendOperationResult<{ ok: boolean; error?: string }>>;
	/** Fallback copy for a test that failed before the backend answered. */
	testFailedMessage: () => string;
	/** Called on any operator edit, so the parent's one dirty flag stays true. */
	markDirty: () => void;
}

export function useAiDecisionPlane(options: UseAiDecisionPlaneOptions) {
	const decisionOptions = decisionProviderOptions();

	const decisionForm = reactive({
		/**
		 * `SETUP_DEFAULT_DECISION_KIND` reaches exactly one install: a brand-new
		 * one, which has no stored row for {@link hydrateDecision} to overwrite it
		 * from. Every existing install lands on `DEFAULT_DECISION_KIND` ('llm'),
		 * which is what it already resolves to — no preselected vendor.
		 */
		kind: SETUP_DEFAULT_DECISION_KIND as DecisionProviderKind,
		modelChoice: decisionProviderMeta(SETUP_DEFAULT_DECISION_KIND)?.defaultModel ?? '',
		modelCustom: '',
		baseUrl: '',
		apiKey: '',
		isFallbackEnabled: false,
	});

	/** The card's master switch. Off is the whole plane's resting state. */
	const decisionEnabled = ref(false);
	/** Session state, never persisted — a stored vendor IS the record of consent. */
	const decisionConsent = ref(false);
	const decisionError = ref<string | null>(null);
	const decisionTestState = ref<TestConnectionState>({ status: 'idle' });
	const hydrating = ref(false);

	const stored = computed(() => {
		const c = options.config();
		return c?.configured ? c : null;
	});
	const storedDecisionKind = computed(() => stored.value?.decisionProviderKind);
	const storedDecisionKeySet = computed(() => stored.value?.isDecisionKeySet ?? false);
	const decisionKeyPreview = computed(() => stored.value?.decisionKeyPreview);

	const decisionMeta = computed(() => decisionProviderMeta(decisionForm.kind));
	const decisionRequiresKey = computed(() => decisionMeta.value?.requiresKey === true);
	const decisionModelOptions = computed(() =>
		modelOptions(decisionMeta.value?.curatedModels ?? [], decisionForm.modelChoice)
	);
	const effectiveDecisionModel = computed(() =>
		resolveModelId(decisionForm.modelChoice, decisionForm.modelCustom)
	);
	/** The host the consent block names — the operator's proxy, or the vendor's. */
	const decisionEndpoint = computed(() =>
		decisionEndpointHost(decisionForm.kind, decisionForm.baseUrl)
	);

	/** Everything the pure rules read, in one place. */
	const decisionSnapshot = computed<DecisionFormSnapshot>(() => ({
		enabled: decisionEnabled.value,
		kind: decisionForm.kind,
		hasStoredKey: storedDecisionKeySet.value,
		apiKey: decisionForm.apiKey,
		consented: decisionConsent.value,
		storedKind: storedDecisionKind.value,
	}));
	const liveDecisionError = computed(() => validateDecisionConfig(decisionSnapshot.value));
	const decisionConsentOwedNow = computed(() => decisionConsentOwed(decisionSnapshot.value));
	const decisionKeyHint = computed(() => decisionKeyNotice(decisionSnapshot.value));

	/**
	 * What the card states in words. `breakerOpen` is deliberately absent:
	 * `internal.decision.breaker.status` is an INTERNAL query no client may call,
	 * so the reason is defined and translated but not yet fed — surfacing it
	 * later is one argument here, not a new UI state.
	 */
	const health = computed(() => ({
		kind: decisionForm.kind,
		hasStoredKey: storedDecisionKeySet.value,
		lastTestFailed: decisionTestState.value.status === 'error',
	}));
	const decisionDegradedReasonList = computed(() => decisionDegradedReasons(health.value));
	const decisionThresholdsInert = computed(() => areDecisionThresholdsInert(health.value));

	/**
	 * Picking a different adapter re-derives everything that belonged to the old
	 * one: its pinned model, its origin, a key typed for it, and the consent that
	 * was given for it. Consent above all — it is given to a NAMED vendor, and
	 * carrying it across a change of vendor would make it meaningless.
	 */
	function applyDecisionDefaults(kind: DecisionProviderKind) {
		const meta = decisionProviderMeta(kind);
		if (!meta) return;
		decisionForm.modelChoice = meta.defaultModel;
		decisionForm.modelCustom = '';
		decisionForm.baseUrl = '';
		decisionForm.apiKey = '';
		decisionConsent.value = false;
		decisionError.value = null;
		decisionTestState.value = { status: 'idle' };
	}

	// flush:'sync' + the `hydrating` guard: fire during assignment, so a config
	// load can be told apart from an operator's pick (the language card's idiom).
	watch(
		() => decisionForm.kind,
		(kind) => {
			if (!hydrating.value) applyDecisionDefaults(kind);
		},
		{ flush: 'sync' }
	);

	/**
	 * Switching the card off returns the plane to the language-backed adapter, so
	 * the collapsed card and the stored row can never disagree — the same rule
	 * the hosted-embedder disclosure follows. It has to travel as an explicit
	 * `'llm'` on the next save: omitting the argument would leave the vendor (and
	 * its key) exactly where it was while the card claimed it was off.
	 */
	// flush:'sync' again, and load-bearing: `decisionSaveArgs` is read
	// synchronously by the save handler, so a queued watcher would let a save
	// that followed the switch straight away send the vendor it just turned off.
	watch(
		decisionEnabled,
		(on) => {
			if (hydrating.value) return;
			if (!on && decisionForm.kind !== DEFAULT_DECISION_KIND) {
				decisionForm.kind = DEFAULT_DECISION_KIND;
			}
			options.markDirty();
		},
		{ flush: 'sync' }
	);

	watch(
		[decisionForm, decisionConsent],
		() => {
			if (!hydrating.value) options.markDirty();
		},
		{ deep: true, flush: 'sync' }
	);

	/** Seed the card from stored config, or leave a brand-new install pre-filled. */
	function hydrateDecision() {
		const c = stored.value;
		hydrating.value = true;
		decisionConsent.value = false;
		decisionError.value = null;
		decisionTestState.value = { status: 'idle' };
		decisionForm.apiKey = '';
		if (c) {
			decisionForm.kind = c.decisionProviderKind ?? DEFAULT_DECISION_KIND;
			decisionForm.modelChoice = c.decisionModel || decisionMeta.value?.defaultModel || '';
			decisionForm.baseUrl = c.decisionBaseUrl ?? '';
			decisionForm.isFallbackEnabled = c.isDecisionFallbackEnabled ?? false;
			// A stored `'llm'` resolves to exactly what an unconfigured install
			// resolves to, so it renders as off rather than as a configured plane.
			decisionEnabled.value =
				c.decisionProviderKind !== undefined && c.decisionProviderKind !== DEFAULT_DECISION_KIND;
		}
		decisionForm.modelCustom = '';
		hydrating.value = false;
	}

	/**
	 * The decision arguments for `saveConfig`, or `{}` — which is the answer for
	 * every install that never opted in, and the reason this card cannot change
	 * a deployment by being merely present. `{}` is also the answer while the
	 * consent gate is unanswered: a blocked save writes nothing at all.
	 */
	function decisionSaveArgs(): DecisionSaveArgs {
		if (!shouldSendDecisionConfig(decisionSnapshot.value)) return {};
		const apiKey = decisionForm.apiKey.trim();
		return {
			decisionProviderKind: decisionForm.kind,
			decisionModel: effectiveDecisionModel.value || undefined,
			decisionBaseUrl: decisionForm.baseUrl.trim() || undefined,
			isDecisionFallbackEnabled: decisionForm.isFallbackEnabled,
			decisionApiKey: apiKey || undefined,
		};
	}

	/** Blocking check the parent runs before it saves. `true` means stop. */
	function decisionSaveBlocked(): boolean {
		decisionError.value = liveDecisionError.value;
		return decisionError.value !== null;
	}

	/** Never keep a plaintext key in memory once it is persisted. */
	function afterDecisionSave() {
		decisionForm.apiKey = '';
		decisionTestState.value = { status: 'idle' };
	}

	/**
	 * Test the STORED decision config, against the provider. The backend asks the
	 * plane one registered probe question (a single yes/no over a nine-word
	 * state), so a revoked key, a base URL that redirects and a retired model
	 * version each come back here in the adapter's own words instead of being
	 * discovered later on the inbound path. It costs a handful of input tokens,
	 * which is the price of a button that means something.
	 */
	async function handleDecisionTest() {
		decisionTestState.value = testConnectionReducer(decisionTestState.value, { type: 'start' });
		const result = await options.runTest({ plane: 'decision' });
		if (!result.ok) {
			// The operation layer already toasted the fault; reflect it inline too.
			decisionTestState.value = testConnectionReducer(decisionTestState.value, {
				type: 'result',
				ok: false,
				error: options.testFailedMessage(),
			});
			return;
		}
		decisionTestState.value = testConnectionReducer(decisionTestState.value, {
			type: 'result',
			ok: result.result.ok,
			error: result.result.error,
		});
	}

	return {
		decisionOptions,
		decisionForm,
		decisionEnabled,
		decisionConsent,
		decisionError,
		decisionTestState,
		decisionMeta,
		decisionRequiresKey,
		decisionModelOptions,
		decisionEndpoint,
		decisionKeyPreview,
		storedDecisionKeySet,
		storedDecisionKind,
		liveDecisionError,
		decisionConsentOwed: decisionConsentOwedNow,
		decisionKeyHint,
		decisionDegradedReasons: decisionDegradedReasonList,
		decisionThresholdsInert,
		decisionFallbackSurfaces: DECISION_FALLBACK_SURFACES,
		decisionThresholds: DECISION_THRESHOLDS,
		hydrateDecision,
		decisionSaveArgs,
		decisionSaveBlocked,
		afterDecisionSave,
		handleDecisionTest,
	};
}
