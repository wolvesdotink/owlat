import type { ActionCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { pluginStepModuleFor } from './steps';
import { pluginAgentStepDefinition, type AgentStepKind } from './steps/catalog';
import {
	buildPluginAgentStepInput,
	isDeclaredPluginCautionEdge,
	parsePluginAgentStepResult,
} from './pluginStepRuntime';

async function recordOutcome(
	ctx: ActionCtx,
	pluginId: string,
	stepKind: string,
	success: boolean
): Promise<void> {
	await ctx.runMutation(internal.plugins.agentStepAuthorization.recordOutcome, {
		pluginId,
		stepKind,
		outcome: success ? 'completed' : 'failed',
	});
}

async function failStep(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>,
	actionId: Id<'agentActions'>,
	pluginId: string,
	stepKind: string
): Promise<void> {
	try {
		const outcome = await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId,
			input: {
				to: 'failed',
				at: Date.now(),
				errorMessage: 'Hosted agent step failed',
				failingActionId: actionId,
			},
		});
		if (outcome.ok) {
			await recordOutcome(ctx, pluginId, stepKind, false).catch(() => undefined);
			return;
		}
	} catch {
		// Fall through and close the action row independently.
	}
	try {
		await ctx.runMutation(internal.inbox.processingLifecycle.recordStepFail, {
			actionId,
			errorMessage: 'Hosted agent step failed after lifecycle completion',
		});
	} catch {
		// The lifecycle transition or cleanup mutation already failed; no safe
		// writer remains, so retain the redacted audit as the final fallback.
	}
	await recordOutcome(ctx, pluginId, stepKind, false).catch(() => undefined);
}

/** Execute one authorized hosted step while the caller retains pipeline ordering. */
export async function runHostedPluginStep(
	ctx: ActionCtx,
	args: {
		readonly inboundMessageId: Id<'inboundMessages'>;
		readonly kind: AgentStepKind;
	},
	continuePipeline: () => Promise<void>
): Promise<void> {
	const definition = pluginAgentStepDefinition(args.kind);
	if (!definition) throw new TypeError(`Missing hosted agent step definition: ${args.kind}`);
	const authorized = await ctx.runMutation(
		internal.plugins.agentStepAuthorization.authorizeExecution,
		{ pluginId: definition.pluginId, stepKind: args.kind }
	);
	if (!authorized) {
		await continuePipeline();
		return;
	}

	const { actionId } = await ctx.runMutation(internal.inbox.processingLifecycle.recordStepBegin, {
		inboundMessageId: args.inboundMessageId,
		actionType: args.kind,
	});
	const startedAt = Date.now();
	let moduleResult: unknown;
	let message: Doc<'inboundMessages'>;
	try {
		const loadedMessage = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
			inboundMessageId: args.inboundMessageId,
		});
		if (!loadedMessage) throw new TypeError('Hosted agent step message no longer exists');
		message = loadedMessage;
		moduleResult = await pluginStepModuleFor(args.kind).execute(
			await buildPluginAgentStepInput(message)
		);
	} catch {
		await failStep(ctx, args.inboundMessageId, actionId, definition.pluginId, args.kind);
		return;
	}
	let shouldContinue = false;
	try {
		const result = parsePluginAgentStepResult(moduleResult);
		const durationMs = Date.now() - startedAt;
		if (result.kind === 'continue') {
			await ctx.runMutation(internal.inbox.processingLifecycle.recordStepEnd, {
				actionId,
				output: result.actionSummaryJson,
				durationMs,
			});
			shouldContinue = true;
		} else {
			if (
				!result.to ||
				!isDeclaredPluginCautionEdge(
					definition.lifecycleEdges,
					definition.placement,
					message.processingStatus,
					result.to
				) ||
				(result.to === 'draft_ready' &&
					(typeof message.draftResponse !== 'string' || message.draftResponse.length === 0))
			) {
				throw new TypeError('Hosted agent step requested an unavailable lifecycle edge');
			}
			const transitionBase = {
				at: Date.now(),
				completedActionId: actionId,
				output: result.actionSummaryJson,
				durationMs,
			};
			const transitionOutcome =
				result.to === 'archived'
					? await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
							inboundMessageId: args.inboundMessageId,
							input: { ...transitionBase, to: 'archived', reason: 'plugin_caution' },
						})
					: result.to === 'draft_ready'
						? await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
								inboundMessageId: args.inboundMessageId,
								input: { ...transitionBase, to: 'draft_ready' },
							})
						: await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
								inboundMessageId: args.inboundMessageId,
								input: {
									to: 'failed',
									at: transitionBase.at,
									errorMessage: 'Hosted agent step requested caution',
									failingActionId: actionId,
								},
							});
			if (!transitionOutcome.ok) {
				throw new TypeError('Hosted agent step transition was rejected');
			}
		}
	} catch {
		await failStep(ctx, args.inboundMessageId, actionId, definition.pluginId, args.kind);
		return;
	}
	await recordOutcome(ctx, definition.pluginId, args.kind, true).catch(() => undefined);
	if (shouldContinue) await continuePipeline();
}
