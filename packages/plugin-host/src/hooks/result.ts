import type { PluginId, SyncHookKind } from '@owlat/plugin-kit';
import { applyPluginUntrustedTextPolicy } from '../untrustedText';
import {
	applyRestrictOnlyGateResult,
	NO_GATE_OBJECTION,
	type RestrictOnlyGateResult,
} from '../gates';

/**
 * Scrubs prompt-injection markers out of untrusted plugin text. The per-field
 * length clamp is owned by this module (draft bodies, gate reasons, and score
 * labels have different bounds), so only the scrubbing function is injected.
 */
export type HookTextScrubber = (untrustedText: string) => string;

/**
 * Why a hook invocation produced the result it did. `ok` means the signed
 * response was accepted; every other value is a failure that routed to the
 * declared fallback. Callers log these; operators see them in delivery logs.
 */
export type SyncHookOutcomeReason =
	| 'ok'
	| 'disabled'
	| 'circuit-open'
	| 'request-too-large'
	| 'transport-blocked'
	| 'transport-timeout'
	| 'transport-network'
	| 'transport-too-large'
	| 'transport-redirect'
	| 'http-status'
	| 'response-unparseable'
	| 'signature-missing'
	| 'signature-invalid'
	| 'timestamp-stale'
	| 'nonce-replayed'
	| 'response-mismatch'
	| 'result-invalid';

interface SyncHookResultBase {
	readonly source: 'hook' | 'fallback';
	readonly reason: SyncHookOutcomeReason;
}

/** Advisory draft suggestion. `suggestion` is scrubbed, clamped, untrusted text. */
export interface DraftHookResult extends SyncHookResultBase {
	readonly kind: 'draft';
	readonly suggestion: string | null;
}

/**
 * Restrict-only gate decision. `gate` is a value that can only withhold approval
 * or abstain — never grant it — and is applied through
 * {@link applyRestrictOnlyGateResult} at the call site.
 */
export interface GateHookResult extends SyncHookResultBase {
	readonly kind: 'gate';
	readonly gate: RestrictOnlyGateResult;
}

/** Advisory score in [0,1] plus scrubbed labels. `null` when unavailable. */
export interface ScoreHookResult extends SyncHookResultBase {
	readonly kind: 'score';
	readonly score: number | null;
	readonly labels: readonly string[];
}

export type SyncHookResult = DraftHookResult | GateHookResult | ScoreHookResult;

export const MAX_DRAFT_CODE_POINTS = 64 * 1_024;
export const MAX_GATE_REASON_CODE_POINTS = 500;
export const MAX_SCORE_LABEL_CODE_POINTS = 64;
export const MAX_SCORE_LABELS = 16;

export const DEFAULT_GATE_FALLBACK_REASON =
	'Connected-app gate hook unavailable — holding this reply for human review.';

/**
 * The declared safe fallback for a kind. Draft and score fail **open** (Owlat
 * keeps its own draft / no score); gate fails **closed toward caution** — a
 * fallback gate result is always an objection, so a failing or malicious
 * endpoint can only ever add caution, never approve or unblock.
 */
export function syncHookFallback(
	kind: SyncHookKind,
	reason: SyncHookOutcomeReason,
	fallbackObjectionReason: string | undefined
): SyncHookResult {
	switch (kind) {
		case 'draft':
			return { kind: 'draft', source: 'fallback', reason, suggestion: null };
		case 'score':
			return { kind: 'score', source: 'fallback', reason, score: null, labels: [] };
		case 'gate':
			return {
				kind: 'gate',
				source: 'fallback',
				reason,
				gate: objection(normalizeReason(fallbackObjectionReason) ?? DEFAULT_GATE_FALLBACK_REASON),
			};
	}
}

/**
 * Validate and normalize the parsed JSON result a connected app returned, for
 * the given hook kind. Returns a `source: 'hook'` result on success, or `null`
 * when the payload is malformed (the caller then falls back). All free text is
 * scrubbed + clamped before it can reach a prompt.
 */
export function normalizeSyncHookResult(
	kind: SyncHookKind,
	pluginId: PluginId,
	raw: unknown,
	scrubPromptInjection: HookTextScrubber
): SyncHookResult | null {
	switch (kind) {
		case 'draft':
			return normalizeDraft(pluginId, raw, scrubPromptInjection);
		case 'gate':
			return normalizeGate(pluginId, raw, scrubPromptInjection);
		case 'score':
			return normalizeScore(pluginId, raw, scrubPromptInjection);
	}
}

function normalizeDraft(
	pluginId: PluginId,
	raw: unknown,
	scrubPromptInjection: HookTextScrubber
): DraftHookResult | null {
	if (!isPlainObject(raw)) return null;
	const keys = ownKeys(raw);
	if (keys.length !== 1 || keys[0] !== 'draft') return null;
	const draft = raw['draft'];
	if (draft === null) {
		return { kind: 'draft', source: 'hook', reason: 'ok', suggestion: null };
	}
	if (!isPlainObject(draft)) return null;
	const draftKeys = ownKeys(draft);
	if (draftKeys.length !== 1 || draftKeys[0] !== 'body') return null;
	const body = draft['body'];
	if (typeof body !== 'string' || body.length === 0) return null;
	const suggestion = scrub(pluginId, body, MAX_DRAFT_CODE_POINTS, scrubPromptInjection);
	if (suggestion === null) return null;
	return { kind: 'draft', source: 'hook', reason: 'ok', suggestion };
}

function normalizeGate(
	pluginId: PluginId,
	raw: unknown,
	scrubPromptInjection: HookTextScrubber
): GateHookResult | null {
	if (!isPlainObject(raw)) return null;
	const outcome = raw['outcome'];
	const keys = ownKeys(raw);
	if (outcome === 'no-objection') {
		if (keys.length !== 1) return null;
		return { kind: 'gate', source: 'hook', reason: 'ok', gate: NO_GATE_OBJECTION };
	}
	if (outcome !== 'objection') return null;
	if (keys.length !== 2 || !keys.includes('reason')) return null;
	const reasonValue = raw['reason'];
	if (typeof reasonValue !== 'string') return null;
	const scrubbed = scrub(pluginId, reasonValue, MAX_GATE_REASON_CODE_POINTS, scrubPromptInjection);
	const normalized = normalizeReason(scrubbed);
	if (normalized === null) return null;
	return { kind: 'gate', source: 'hook', reason: 'ok', gate: objection(normalized) };
}

function normalizeScore(
	pluginId: PluginId,
	raw: unknown,
	scrubPromptInjection: HookTextScrubber
): ScoreHookResult | null {
	if (!isPlainObject(raw)) return null;
	const keys = ownKeys(raw);
	for (const key of keys) {
		if (key !== 'score' && key !== 'labels') return null;
	}
	const score = raw['score'];
	if (typeof score !== 'number' || !Number.isFinite(score)) return null;
	const clampedScore = Math.min(1, Math.max(0, score));
	const labels = normalizeLabels(pluginId, raw['labels'], scrubPromptInjection);
	if (labels === null) return null;
	return { kind: 'score', source: 'hook', reason: 'ok', score: clampedScore, labels };
}

function normalizeLabels(
	pluginId: PluginId,
	raw: unknown,
	scrubPromptInjection: HookTextScrubber
): readonly string[] | null {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) return null;
	if (raw.length > MAX_SCORE_LABELS) return null;
	const labels: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'string' || entry.length === 0) return null;
		const scrubbed = scrub(pluginId, entry, MAX_SCORE_LABEL_CODE_POINTS, scrubPromptInjection);
		const normalized = normalizeReason(scrubbed);
		if (normalized === null) return null;
		labels.push(normalized);
	}
	return Object.freeze(labels);
}

function scrub(
	pluginId: PluginId,
	text: string,
	maximumCodePoints: number,
	scrubPromptInjection: HookTextScrubber
): string | null {
	try {
		return applyPluginUntrustedTextPolicy(pluginId, text, {
			maximumCodePoints,
			scrubPromptInjection,
		});
	} catch {
		return null;
	}
}

function objection(reason: string): RestrictOnlyGateResult {
	// Route through the restrict-only primitive: even here the value can only be
	// an objection or no-objection, never an approval.
	const decision = applyRestrictOnlyGateResult(
		{ allowed: true, objections: [] },
		{ outcome: 'objection', reason }
	);
	return decision.allowed
		? NO_GATE_OBJECTION
		: { outcome: 'objection', reason: decision.objections[0] ?? reason };
}

function normalizeReason(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function ownKeys(value: Record<string, unknown>): string[] {
	return Object.keys(value);
}
