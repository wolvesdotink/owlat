'use node';

import type { PluginDraftStrategyInput, PluginDraftStrategyModule } from '@owlat/plugin-kit';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import { bindSystemBundledPluginLlm } from '../../plugins/llm';
import { pluginDraftStrategyDefinition } from '../../plugins/draftStrategyCatalog';
import { BUNDLED_PLUGIN_DRAFT_STRATEGY_MODULES } from '../../plugins/draftStrategyModules.generated';
import { detectInjection, INJECTION_CONFIDENCE_THRESHOLD } from '../steps/security_scan/patterns';

const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_TRUSTED_FIELD_BYTES = 8 * 1024;
const MAX_DRAFT_BYTES = 64 * 1024;
const DRAFT_STRATEGY_MODULES = BUNDLED_PLUGIN_DRAFT_STRATEGY_MODULES as readonly {
	readonly kind: string;
	readonly pluginId: string;
	readonly module: PluginDraftStrategyModule;
}[];

interface DraftStrategySource {
	readonly audience: 'organization' | 'personal';
	readonly context: string;
	readonly confirmedContext?: string;
	readonly stanceGuidance?: string;
	readonly classification: PluginDraftStrategyInput['classification'];
	readonly toneInstruction: string;
	readonly signatureInstruction: string;
	readonly voiceSection: string;
}

type FailureReason = 'draft_strategy_failed' | 'draft_strategy_invalid' | 'draft_strategy_timeout';

export async function runHostedDraftStrategy(
	ctx: ActionCtx,
	strategyKind: string,
	source: DraftStrategySource
): Promise<string | null> {
	const definition = pluginDraftStrategyDefinition(strategyKind);
	const registration = DRAFT_STRATEGY_MODULES.find((entry) => entry.kind === strategyKind);
	if (!definition || !registration || registration.pluginId !== definition.pluginId) return null;
	const authorized = await ctx.runMutation(
		internal.plugins.draftStrategyAuthorization.authorizeExecution,
		{ pluginId: definition.pluginId, strategyKind }
	);
	if (!authorized) return null;
	let input: PluginDraftStrategyInput;
	try {
		input = snapshotInput(source);
	} catch {
		await recordStrategyFailure(ctx, definition.pluginId, strategyKind, 'draft_strategy_invalid');
		return null;
	}
	const executionController = new AbortController();
	try {
		const strategyWork = Promise.resolve().then(() =>
			registration.module.generate(
				input,
				Object.freeze({
					llm: bindSystemBundledPluginLlm(ctx, definition.pluginId, executionController.signal),
				})
			)
		);
		// Promise.race observes late rejection already; this explicit drain also
		// documents that timed-out plugin work is never allowed to become unhandled.
		void strategyWork.catch(() => undefined);
		const result = await withTimeout(strategyWork, definition.timeoutMs, executionController);
		const draftBody = validateResult(result);
		await ctx.runMutation(internal.plugins.draftStrategyAuthorization.recordOutcome, {
			pluginId: definition.pluginId,
			strategyKind,
			outcome: 'completed',
		});
		return draftBody;
	} catch (error) {
		await recordStrategyFailure(
			ctx,
			definition.pluginId,
			strategyKind,
			error instanceof StrategyTimeoutError
				? 'draft_strategy_timeout'
				: error instanceof InvalidStrategyResultError
					? 'draft_strategy_invalid'
					: 'draft_strategy_failed'
		);
		return null;
	} finally {
		// A strategy gets a single host-owned lease. Completion, validation failure,
		// audit failure, and timeout all revoke every exposed service capability.
		// The timeout path aborts eagerly inside withTimeout as well.
		executionController.abort();
	}
}

function snapshotInput(source: DraftStrategySource): PluginDraftStrategyInput {
	assertBounded(source.context, MAX_CONTEXT_BYTES);
	for (const value of [
		source.confirmedContext,
		source.stanceGuidance,
		source.toneInstruction,
		source.signatureInstruction,
		source.voiceSection,
	])
		if (value !== undefined) assertBounded(value, MAX_TRUSTED_FIELD_BYTES);
	return Object.freeze({
		audience: source.audience,
		context: source.context,
		...(source.confirmedContext === undefined ? {} : { confirmedContext: source.confirmedContext }),
		...(source.stanceGuidance === undefined ? {} : { stanceGuidance: source.stanceGuidance }),
		classification: Object.freeze({ ...source.classification }),
		toneInstruction: source.toneInstruction,
		signatureInstruction: source.signatureInstruction,
		voiceSection: source.voiceSection,
	});
}

function validateResult(value: unknown): string {
	if (
		value === null ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		throw new InvalidStrategyResultError();
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (
		Reflect.ownKeys(descriptors).length !== 1 ||
		!descriptors['draftBody']?.enumerable ||
		!('value' in descriptors['draftBody']) ||
		typeof descriptors['draftBody'].value !== 'string'
	)
		throw new InvalidStrategyResultError();
	const draftBody = descriptors['draftBody'].value.trim();
	if (!draftBody || new TextEncoder().encode(draftBody).byteLength > MAX_DRAFT_BYTES)
		throw new InvalidStrategyResultError();
	const injection = detectInjection(draftBody);
	if (injection.detected && injection.confidence >= INJECTION_CONFIDENCE_THRESHOLD)
		throw new InvalidStrategyResultError();
	return draftBody;
}

function assertBounded(value: string, maximum: number): void {
	if (new TextEncoder().encode(value).byteLength > maximum) throw new InvalidStrategyResultError();
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	executionController: AbortController
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					executionController.abort();
					reject(new StrategyTimeoutError());
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function recordStrategyFailure(
	ctx: ActionCtx,
	pluginId: string,
	strategyKind: string,
	reasonCode: FailureReason
): Promise<void> {
	await ctx
		.runMutation(internal.plugins.draftStrategyAuthorization.recordOutcome, {
			pluginId,
			strategyKind,
			outcome: 'failed',
			reasonCode,
		})
		.catch(() => null);
}

class InvalidStrategyResultError extends Error {}
class StrategyTimeoutError extends Error {}
