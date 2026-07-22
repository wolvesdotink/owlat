/**
 * Dispatch pipeline — the ordered pre-send check sequence.
 *
 * A Phase is a typed step `Phase<TIn, TOut>` whose input/output ctx threads
 * forward into the next phase. The runner short-circuits on the first
 * non-`continue` outcome and returns typed defer/drop data; it never throws
 * `DeferError`. Translation to GroupMQ's `DeferError` happens in
 * `apps/mta/src/queue/handler.ts`.
 *
 * The generic compose-and-short-circuit machinery lives in
 * `apps/mta/src/lib/phasePipeline.ts`; this module binds it to the dispatch
 * domain's deps/ctx and its `defer`/`drop` terminal vocabulary.
 *
 * See ADR-0007 and CONTEXT.md's MTA dispatch section.
 */

import type { BasePhaseCtx, PhaseDeps } from './types.js';
import {
	compose as composeGeneric,
	runPipeline as runPipelineGeneric,
	type ComposedPipeline,
	type Phase as GenericPhase,
	type PhaseOutcome as GenericPhaseOutcome,
	type Pipeline as GenericPipeline,
	type PipelineResult as GenericPipelineResult,
} from '../lib/phasePipeline.js';

/**
 * A dispatch terminal outcome.
 *
 * - `defer` re-queues the attempt with the given delay.
 * - `drop` ends the attempt without a re-queue (used by content screening
 *   and the suppression check).
 */
export type DispatchTerminal =
	| { kind: 'defer'; delayMs: number; reason: string }
	| { kind: 'routing_reentry'; reason: string }
	| { kind: 'drop'; status: 'screened' | 'suppressed'; reason: string };

/**
 * Outcome a phase emits per execution.
 *
 * - `continue` carries the ctx for the next phase. Most phases pass it
 *   through unchanged (`Phase<X, X>`); the two enriching phases
 *   (`resolvePool`, `selectIp`) widen the ctx type.
 * - `defer` / `drop` short-circuit the pipeline (see `DispatchTerminal`).
 */
export type PhaseOutcome<TOut extends BasePhaseCtx> = GenericPhaseOutcome<TOut, DispatchTerminal>;

/**
 * One step in the pipeline. The runner discovers the step's name via this
 * record so logs and telemetry can attribute defers to the phase that
 * emitted them.
 */
export type Phase<TIn extends BasePhaseCtx, TOut extends BasePhaseCtx> = GenericPhase<
	PhaseDeps,
	TIn,
	TOut,
	DispatchTerminal
>;

/**
 * The pipeline's collected output. Mirrors `PhaseOutcome` but is what the
 * runner returns — the caller (handler.ts) translates `defer` into a
 * `DeferError` throw.
 */
export type PipelineResult<TOut extends BasePhaseCtx> = GenericPipelineResult<
	TOut,
	DispatchTerminal
>;

/**
 * A composed pipeline. Carries the input ctx type and the final output ctx
 * type so callers and tests can pass the right initial ctx.
 */
export type Pipeline<TIn extends BasePhaseCtx, TOut extends BasePhaseCtx> = GenericPipeline<
	PhaseDeps,
	BasePhaseCtx,
	TIn,
	TOut,
	DispatchTerminal
>;

/**
 * Compose a list of phases into a Pipeline.
 *
 * The output ctx type of each phase must match the input ctx type of the
 * next; TypeScript catches a reordering bug at compile time via the
 * generic `Compose` helper.
 */
export function compose<
	const Phases extends readonly [
		Phase<BasePhaseCtx, BasePhaseCtx>,
		...Array<Phase<BasePhaseCtx, BasePhaseCtx>>,
	],
>(...phases: Phases): ComposedPipeline<PhaseDeps, BasePhaseCtx, DispatchTerminal, Phases> {
	return composeGeneric<PhaseDeps, BasePhaseCtx, DispatchTerminal, Phases>(...phases);
}

/**
 * Run a pipeline against a base ctx. Thin wrapper over `pipeline.run` for
 * symmetry with `applyEffects` / `reduce` at the call site.
 */
export function runPipeline<TIn extends BasePhaseCtx, TOut extends BasePhaseCtx>(
	deps: PhaseDeps,
	pipeline: Pipeline<TIn, TOut>,
	ctx: TIn
): Promise<PipelineResult<TOut>> {
	return runPipelineGeneric(deps, pipeline, ctx);
}
