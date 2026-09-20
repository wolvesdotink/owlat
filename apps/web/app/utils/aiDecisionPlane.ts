/**
 * The DECISION plane's pure settings logic: what the card may pre-fill, when
 * consent is owed, what a save is allowed to send, and when the plane is
 * degraded enough that no threshold may be read off it.
 *
 * Sibling of `utils/aiProviders.ts`, which holds the catalog this reads. Split
 * out for the same reason the backend split `lib/decisionProvider.ts` off
 * `lib/llmProvider.ts`: that file is a CATALOG, and the rules below are
 * behaviour, which is the part worth testing on its own (`__tests__/
 * aiDecisionPlane.test.ts`) rather than through a mounted card.
 *
 * The one rule everything here serves: AN INSTALL THAT NEVER OPTED IN MUST NOT
 * CHANGE. No banner, no nudge, no preselected vendor, and — because
 * `saveConfig` treats an omitted `decisionProviderKind` as "leave the plane
 * alone" rather than as a clear — no decision arguments on a save that only
 * edited the language card. Everything that could push an operator toward a
 * third party is gated on {@link isBrandNewDecisionConfig}, which is true for
 * exactly one install: one that has no AI provider config at all yet.
 */

import { decisionProviderMeta, type DecisionProviderKind } from '~/utils/aiProviders';

/** Message-key root for this module; see `i18n/locales/en.json`. */
const K = 'shared.aiProviders.decision';

/**
 * The wizard's pre-filled answer for a BRAND-NEW install — "what we recommend".
 *
 * Deliberately not the same constant as the backend's `DEFAULT_DECISION_KIND`
 * (`'llm'`), which is "what an install that never opted in resolves to". Giving
 * the two one name would collapse a recommendation into a migration.
 */
export const SETUP_DEFAULT_DECISION_KIND: DecisionProviderKind = 'typesafe';

/**
 * What resolution falls back to when no decision key resolves — the
 * language-backed adapter, i.e. today's behaviour. Mirrors the backend's
 * `DEFAULT_DECISION_KIND`.
 */
export const DEFAULT_DECISION_KIND: DecisionProviderKind = 'llm';

/**
 * True only for an install with no AI provider config row at all. An install
 * that has a config but no decision plane is an EXISTING install: it gets the
 * option, and nothing else.
 */
export function isBrandNewDecisionConfig(config: { configured?: boolean } | null): boolean {
	return config?.configured !== true;
}

/** The decision half of the settings form, as the pure rules below read it. */
export interface DecisionFormSnapshot {
	/** The operator has the plane switched on in this form. */
	readonly enabled: boolean;
	readonly kind: DecisionProviderKind;
	/** A key is already encrypted on the row for this plane. */
	readonly hasStoredKey: boolean;
	/** Freshly typed key, as typed (trimmed here, not by the caller). */
	readonly apiKey: string;
	/** The consent checkbox, in this session. */
	readonly consented: boolean;
	/** What is persisted today — `undefined` on an install that never opted in. */
	readonly storedKind?: DecisionProviderKind;
}

/**
 * Whether this save is turning a third-party decision provider on for the first
 * time, and therefore owes the operator the consent block.
 *
 * Owed once per vendor, not once per save: an operator who already runs
 * TypeSafe read it when they enabled it, and re-asking on every model-id edit
 * would train them to click past it. Switching BACK to the language-backed
 * adapter never owes consent — nothing leaves the deployment on that path.
 */
export function decisionConsentOwed(state: DecisionFormSnapshot): boolean {
	if (!state.enabled) return false;
	if (decisionProviderMeta(state.kind)?.requiresKey !== true) return false;
	return state.storedKind !== state.kind;
}

/**
 * Blocking validation for the decision card. Returns a message KEY the renderer
 * translates, or `null` when the card may be saved.
 *
 * A missing key is NOT blocking, and that is deliberate: a self-hosted
 * deployment may supply `TYPESAFE_API_KEY` through its environment, in which
 * case the columns are legitimately empty and the backend accepts the save.
 * Blocking here would make the settings page unusable on exactly the installs
 * that configured themselves the self-hosted way. {@link decisionKeyNotice}
 * says so inline instead.
 */
export function validateDecisionConfig(state: DecisionFormSnapshot): string | null {
	if (!state.enabled) return null;
	if (decisionConsentOwed(state) && !state.consented) return `${K}.validation.consentRequired`;
	return null;
}

/**
 * The non-blocking note under the key field when a keyed adapter is selected
 * and we can see no key: the save may still be correct, because the deployment
 * may hold the key in its environment, and the card must not claim otherwise.
 * `null` when there is nothing to say.
 */
export function decisionKeyNotice(state: DecisionFormSnapshot): string | null {
	if (!state.enabled) return null;
	if (decisionProviderMeta(state.kind)?.requiresKey !== true) return null;
	if (state.hasStoredKey || state.apiKey.trim().length > 0) return null;
	return `${K}.keyFromEnvironment`;
}

/**
 * Whether a save should carry the decision arguments at all.
 *
 * Omitting them leaves the stored plane untouched, which is what an install
 * that never opted in needs — and what the language card needs when it is the
 * only thing being edited. They travel when the operator has the plane on, or
 * when a plane is already stored and the form is turning it back OFF (which
 * travels as an explicit `'llm'`, since an omission would not clear it).
 */
export function shouldSendDecisionConfig(state: DecisionFormSnapshot): boolean {
	if (validateDecisionConfig(state) !== null) return false;
	return state.enabled || state.storedKind !== undefined;
}

/**
 * Why the plane cannot be trusted with a threshold right now. Every member is
 * rendered as a SENTENCE in both catalogs — the card says what is wrong and
 * what happens instead, because "the slider is greyed out" answers neither.
 *
 *  • `languageBacked` — the selected adapter is the language model, which
 *    returns degenerate probabilities and is stamped `calibrated: false`.
 *  • `keyMissing`     — a keyed adapter is selected with no key we can see, so
 *    resolution degrades to the language plane (unless the deployment supplies
 *    one through its environment, which a query cannot tell us).
 *  • `breakerOpen`    — the plane has been failing and the breaker has cut it.
 *  • `testFailed`     — the last key test came back with an error.
 */
export type DecisionDegradedReason = 'languageBacked' | 'keyMissing' | 'breakerOpen' | 'testFailed';

/** What the card needs to know to decide the two questions below. */
export interface DecisionHealthInput {
	readonly kind: DecisionProviderKind;
	readonly hasStoredKey: boolean;
	/** From `internal.decision.breaker.status`, once a query surfaces it. */
	readonly breakerOpen?: boolean;
	/** The last decision-plane connection test ended in an error. */
	readonly lastTestFailed?: boolean;
}

/**
 * Every reason the plane is degraded, most structural first: an operator
 * reading top-down learns what the plane IS before they learn what went wrong
 * with it this hour.
 */
export function decisionDegradedReasons(input: DecisionHealthInput): DecisionDegradedReason[] {
	const reasons: DecisionDegradedReason[] = [];
	const meta = decisionProviderMeta(input.kind);
	if (meta?.calibrated !== true) reasons.push('languageBacked');
	else if (!input.hasStoredKey) reasons.push('keyMissing');
	if (input.breakerOpen === true) reasons.push('breakerOpen');
	if (input.lastTestFailed === true) reasons.push('testFailed');
	return reasons;
}

/**
 * Thresholds are inert whenever ANY reason stands. Not a styling decision: a
 * threshold read off an uncalibrated number is a number that looks like a
 * probability and is not one, and acting on it is how a calibrated-sounding
 * 0.91 sends the wrong mail.
 */
export function areDecisionThresholdsInert(input: DecisionHealthInput): boolean {
	return decisionDegradedReasons(input).length > 0;
}

/** Window the settings card summarises the plane's recent behaviour over. */
export const DECISION_HEALTH_HOURS = 24;

/**
 * The three rates `analytics.llmUsage.getDecisionPlaneCounters` reports, as the
 * card reads them. They are derived from the SAME ledger rows the enforced
 * spend ceiling reads, which is why they can be trusted against the bill.
 */
export interface DecisionPlaneHealth {
	/** Attempts in the window — calls made, not answers returned. */
	readonly attempts: number;
	readonly fallbackRate: number;
	readonly uncalibratedRate: number;
	readonly throttledRate: number;
}

/** One line of the health block: a message-key suffix and the rate to render. */
export interface DecisionHealthRow {
	readonly id: 'fallback' | 'uncalibrated' | 'throttled';
	readonly rate: number;
}

/**
 * The three counters in the order the card lists them: the one that costs money
 * first, then the one that makes every threshold inert, then the one that
 * explains both. An operator scanning the block sees the bill before the cause.
 */
export function decisionHealthRows(health: DecisionPlaneHealth): DecisionHealthRow[] {
	return [
		{ id: 'fallback', rate: health.fallbackRate },
		{ id: 'uncalibrated', rate: health.uncalibratedRate },
		{ id: 'throttled', rate: health.throttledRate },
	];
}

/**
 * The host every decision request goes to, for the consent block — the
 * operator's own override when they front the vendor with a proxy, otherwise
 * the adapter's origin. An unparseable override is handed back verbatim rather
 * than swallowed: a consent screen that silently showed the vendor's host while
 * the config pointed somewhere else would be the one lie this block cannot
 * afford.
 */
export function decisionEndpointHost(kind: DecisionProviderKind, baseUrl?: string): string {
	const configured = baseUrl?.trim();
	const fallback = decisionProviderMeta(kind)?.defaultBaseUrl ?? '';
	const source = configured || fallback;
	if (!source) return '';
	try {
		return new URL(source).host;
	} catch {
		return source;
	}
}

/**
 * The surfaces the one fallback hop is decided PER, and whether an operator may
 * decide it. The split is the whole point: the agent pipeline is a person
 * waiting on a reply, so a failed judgement there should ask the language model
 * and move on; the background classifiers run on every message that arrives, so
 * the same hop re-routes the entire inbound flow onto a model that costs twenty
 * to fifty times more — on a path fed by strangers sending us email.
 *
 * `operatorControlled: false` is not a control we forgot to build. It is the
 * answer, and the card states it in words.
 */
export interface DecisionFallbackSurface {
	readonly id: 'agent' | 'classifiers';
	/** Message key for the surface name. */
	readonly label: string;
	/** Message key for the sentence explaining the setting. */
	readonly body: string;
	readonly operatorControlled: boolean;
}

export const DECISION_FALLBACK_SURFACES: readonly DecisionFallbackSurface[] = [
	{
		id: 'agent',
		label: `${K}.fallback.agent.label`,
		body: `${K}.fallback.agent.body`,
		operatorControlled: true,
	},
	{
		id: 'classifiers',
		label: `${K}.fallback.classifiers.label`,
		body: `${K}.fallback.classifiers.body`,
		operatorControlled: false,
	},
] as const;

/**
 * The thresholds, NAMED PER ANSWER TYPE — never one "confidence" slider.
 *
 * A yes/no answer (a Noul) carries no confidence field at all, by design: its
 * probability IS the answer, and the only meaningful threshold on it is how far
 * that probability sits from 0.5. A category or score answer does carry a
 * confidence, which describes how peaked the distribution across the options
 * is. One slider labelled "confidence" would quietly mean two different
 * quantities and be wrong for one of them.
 */
export interface DecisionThreshold {
	readonly id: 'noul' | 'choice';
	/** Message key for the answer-type name. */
	readonly label: string;
	/** Message key for the sentence describing what the number measures. */
	readonly body: string;
}

export const DECISION_THRESHOLDS: readonly DecisionThreshold[] = [
	{ id: 'noul', label: `${K}.thresholds.noul.label`, body: `${K}.thresholds.noul.body` },
	{ id: 'choice', label: `${K}.thresholds.choice.label`, body: `${K}.thresholds.choice.body` },
] as const;
