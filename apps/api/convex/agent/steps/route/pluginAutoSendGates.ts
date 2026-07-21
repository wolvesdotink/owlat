import {
	parsePluginId,
	PLUGIN_AUTONOMY_GATE_TIMEOUT_MAX_MS,
	type PluginAutonomyGateInput,
	type PluginAutonomyGateModule,
} from '@owlat/plugin-kit';
import { applyPluginUntrustedTextPolicy, applyRestrictOnlyGateResult } from '@owlat/plugin-host';
import { internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import type { ActionCtx } from '../../../_generated/server';
import { scrubForInjection } from '../../../assistant/prompt';
import { truncateCodePoints } from '../../pluginStepRuntime';
import { AUTONOMY_GATE_CATALOG } from '../../../plugins/autonomyGateCatalog';
import { BUNDLED_PLUGIN_AUTONOMY_GATE_MODULES } from '../../../plugins/autonomyGateModules.generated';
import type { AutoSendGateDecision } from './autoSendGates';

export interface HostedAutonomyGateInputLimits {
	readonly fromCodePoints: number;
	readonly toCodePoints: number;
	readonly subjectCodePoints: number;
	readonly draftCodePoints: number;
	readonly classificationCodePoints: number;
}

export const HOSTED_AUTONOMY_GATE_INPUT_LIMITS: HostedAutonomyGateInputLimits = Object.freeze({
	fromCodePoints: 512,
	toCodePoints: 2_048,
	subjectCodePoints: 1_024,
	draftCodePoints: 64 * 1_024,
	classificationCodePoints: 128,
});
const MAX_REASON_CODE_POINTS = 300;
const MIN_GATE_TIMEOUT_MS = 100;

type FailureReason = 'autonomy_gate_failed' | 'autonomy_gate_invalid' | 'autonomy_gate_timeout';

interface GeneratedAutonomyGateModule {
	readonly kind: string;
	readonly pluginId: string;
	readonly module: unknown;
}

const GATE_MODULES = BUNDLED_PLUGIN_AUTONOMY_GATE_MODULES as readonly GeneratedAutonomyGateModule[];

const safe = (): AutoSendGateDecision => Object.freeze({ safe: true });
const unsafe = (reason: string): AutoSendGateDecision => Object.freeze({ safe: false, reason });

/** Runs deterministic manifest gates only after every immutable core gate passed. */
export async function runHostedAutoSendGates(
	action: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>
): Promise<AutoSendGateDecision> {
	if (AUTONOMY_GATE_CATALOG.length === 0) return safe();
	if (hasDuplicateCatalogKinds()) return unavailableGate();

	let input: PluginAutonomyGateInput;
	try {
		const message = await action.runQuery(internal.agent.agentPipeline.getMessage, {
			inboundMessageId,
		});
		if (!message) return unavailableGate();
		input = snapshotInput(message);
	} catch {
		return unavailableGate();
	}

	for (const definition of AUTONOMY_GATE_CATALOG) {
		let pluginId;
		try {
			pluginId = parsePluginId(definition.pluginId);
		} catch {
			return unavailableGate();
		}
		const registrations = GATE_MODULES.filter(
			(candidate) =>
				candidate.kind === definition.kind && candidate.pluginId === definition.pluginId
		);
		if (registrations.length !== 1) return unavailableGate();
		const timeoutMs = boundedTimeout(definition.timeoutMs);
		if (timeoutMs === null) return unavailableGate();

		let authorized: boolean;
		try {
			authorized = await action.runMutation(
				internal.plugins.autonomyGateAuthorization.authorizeExecution,
				{ pluginId, gateKind: definition.kind }
			);
		} catch {
			return unavailableGate();
		}
		if (!authorized) return unavailableGate();
		const gate = snapshotGateModule(registrations[0]!.module);
		if (!gate) return unavailableGate();

		const controller = new AbortController();
		try {
			const work = Promise.resolve().then(() =>
				gate.evaluate(input, Object.freeze({ signal: controller.signal }))
			);
			void work.catch(() => undefined);
			const rawResult = await withTimeout(work, timeoutMs, controller);
			const objection = parseObjection(pluginId, rawResult);
			if (objection.kind === 'invalid') {
				await recordFailure(action, pluginId, definition.kind, 'autonomy_gate_invalid');
				return invalidGateResult(definition.label);
			}
			await action.runMutation(internal.plugins.autonomyGateAuthorization.recordOutcome, {
				pluginId,
				gateKind: definition.kind,
				outcome: 'completed',
			});
			if (objection.kind === 'objection') {
				return unsafe(`Plugin gate ${definition.label} requires human review: ${objection.reason}`);
			}
		} catch (error) {
			const reasonCode: FailureReason =
				error instanceof GateTimeoutError ? 'autonomy_gate_timeout' : 'autonomy_gate_failed';
			await recordFailure(action, pluginId, definition.kind, reasonCode);
			return reasonCode === 'autonomy_gate_timeout'
				? unsafe(
						`Plugin gate ${definition.label} timed out; not auto-sending — routing to human review.`
					)
				: unavailableGate();
		} finally {
			controller.abort();
		}
	}
	return safe();
}

function snapshotInput(message: Doc<'inboundMessages'>): PluginAutonomyGateInput {
	const classification = message.classification;
	return Object.freeze({
		from: truncateCodePoints(message.from ?? '', HOSTED_AUTONOMY_GATE_INPUT_LIMITS.fromCodePoints),
		to: truncateCodePoints(message.to ?? '', HOSTED_AUTONOMY_GATE_INPUT_LIMITS.toCodePoints),
		subject: truncateCodePoints(
			message.subject ?? '',
			HOSTED_AUTONOMY_GATE_INPUT_LIMITS.subjectCodePoints
		),
		draftBody: truncateCodePoints(
			message.draftResponse ?? '',
			HOSTED_AUTONOMY_GATE_INPUT_LIMITS.draftCodePoints
		),
		...(classification
			? {
					classification: Object.freeze({
						category: sanitizeClassificationValue(classification.category),
						intent: sanitizeClassificationValue(classification.intent),
						sentiment: sanitizeClassificationValue(classification.sentiment),
						priority: sanitizeClassificationValue(classification.priority),
					}),
				}
			: {}),
	});
}

function sanitizeClassificationValue(value: string): string {
	return truncateCodePoints(
		scrubForInjection(value),
		HOSTED_AUTONOMY_GATE_INPUT_LIMITS.classificationCodePoints
	);
}

function hasDuplicateCatalogKinds(): boolean {
	const kinds = new Set<string>();
	for (const definition of AUTONOMY_GATE_CATALOG) {
		if (kinds.has(definition.kind)) return true;
		kinds.add(definition.kind);
	}
	return false;
}

function snapshotGateModule(value: unknown): PluginAutonomyGateModule | null {
	try {
		if (!isPlainObject(value)) return null;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Reflect.ownKeys(descriptors).length !== 1) return null;
		const evaluate = descriptors['evaluate'];
		if (!evaluate || !evaluate.enumerable || !('value' in evaluate)) return null;
		if (typeof evaluate.value !== 'function') return null;
		return Object.freeze({ evaluate: evaluate.value });
	} catch {
		return null;
	}
}

function parseObjection(
	pluginId: ReturnType<typeof parsePluginId>,
	value: unknown
):
	| { readonly kind: 'none' }
	| { readonly kind: 'objection'; readonly reason: string }
	| { readonly kind: 'invalid' } {
	if (!isPlainObject(value)) return { kind: 'invalid' };
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Reflect.ownKeys(descriptors);
	const outcome = descriptors['outcome'];
	if (!outcome?.enumerable || !('value' in outcome)) return { kind: 'invalid' };
	if (outcome.value === 'no-objection' && keys.length === 1) {
		const decision = applyRestrictOnlyGateResult(
			{ allowed: true, objections: [] },
			{ outcome: 'no-objection' }
		);
		return decision.allowed ? { kind: 'none' } : { kind: 'invalid' };
	}
	const reason = descriptors['reason'];
	if (
		outcome.value !== 'objection' ||
		keys.length !== 2 ||
		!reason?.enumerable ||
		!('value' in reason) ||
		typeof reason.value !== 'string' ||
		reason.value.trim().length === 0
	) {
		return { kind: 'invalid' };
	}
	const protectedReason = applyPluginUntrustedTextPolicy(pluginId, reason.value.trim(), {
		maximumCodePoints: MAX_REASON_CODE_POINTS,
		scrubPromptInjection: scrubForInjection,
	}).trim();
	if (!protectedReason) return { kind: 'invalid' };
	const decision = applyRestrictOnlyGateResult(
		{ allowed: true, objections: [] },
		{ outcome: 'objection', reason: protectedReason }
	);
	return decision.allowed
		? { kind: 'invalid' }
		: { kind: 'objection', reason: decision.objections[0]! };
}

function boundedTimeout(value: number): number | null {
	if (!Number.isSafeInteger(value) || value < MIN_GATE_TIMEOUT_MS) return null;
	return Math.min(value, PLUGIN_AUTONOMY_GATE_TIMEOUT_MAX_MS);
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	controller: AbortController
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new GateTimeoutError());
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function recordFailure(
	action: ActionCtx,
	pluginId: string,
	gateKind: string,
	reasonCode: FailureReason
): Promise<void> {
	await action
		.runMutation(internal.plugins.autonomyGateAuthorization.recordOutcome, {
			pluginId,
			gateKind,
			outcome: 'failed',
			reasonCode,
		})
		.catch(() => null);
}

function unavailableGate(): AutoSendGateDecision {
	return unsafe(
		'A configured plugin gate is unavailable; not auto-sending — routing to human review.'
	);
}

function invalidGateResult(label: string): AutoSendGateDecision {
	return unsafe(
		`Plugin gate ${label} returned an invalid result; not auto-sending — routing to human review.`
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

class GateTimeoutError extends Error {}
