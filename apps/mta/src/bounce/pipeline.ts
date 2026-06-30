/**
 * Bounce intake pipeline — the ordered classification sequence for inbound
 * SMTP messages (DSNs, ARF/FBL reports, mailbox deliveries, inbound routes).
 *
 * The compose-and-short-circuit machinery is shared with the dispatch
 * pipeline (ADR-0007) and lives in `apps/mta/src/lib/phasePipeline.ts`; this
 * module binds it to the bounce domain's deps/ctx and its own terminal
 * vocabulary. The Bounce pipeline never `defer`s (the bounce SMTP server
 * doesn't re-queue jobs) — it short-circuits with one of two terminal
 * outcomes:
 *
 *   - `dropSilently` — accept the SMTP transaction but emit no effects
 *     (e.g., duplicate FBL complaint already counted).
 *   - `bounceTo` — short-circuit with a typed `BounceAttempt` that the
 *     reducer turns into a list of `BounceEffect`s.
 *
 * See ADR-0007 follow-up #4 and CONTEXT.md's MTA dispatch / inbound
 * intake section.
 */

import type { BasePhaseCtx, BounceAttempt, PhaseDeps } from './types.js';
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
 * A bounce terminal outcome.
 *
 * - `dropSilently` ends the attempt without producing effects. The bounce
 *   SMTP transaction is still ACK-ed (we never NACK accepted bytes).
 * - `bounceTo` ends the attempt with a typed `BounceAttempt`; the reducer
 *   takes that and emits the matching effect list.
 */
export type BounceTerminal =
	| { kind: 'dropSilently'; reason: string }
	| { kind: 'bounceTo'; attempt: BounceAttempt };

/**
 * Outcome a phase emits per execution.
 *
 * - `continue` carries the ctx for the next phase. Most phases pass it
 *   through unchanged (`Phase<X, X>`); only `resolveRoute` widens the ctx
 *   type (`+ route`) so that `stageAttachments` can read it.
 * - `dropSilently` / `bounceTo` short-circuit the pipeline (see
 *   `BounceTerminal`).
 */
export type PhaseOutcome<TOut extends BasePhaseCtx> = GenericPhaseOutcome<TOut, BounceTerminal>;

/**
 * One step in the pipeline. The runner discovers the step's name via this
 * record so logs and telemetry can attribute drops to the phase that
 * emitted them.
 */
export type Phase<TIn extends BasePhaseCtx, TOut extends BasePhaseCtx> = GenericPhase<
	PhaseDeps,
	TIn,
	TOut,
	BounceTerminal
>;

/**
 * The pipeline's collected output. Mirrors `PhaseOutcome` but is what the
 * runner returns — the caller (server.ts) feeds `attempt` into `reduce`
 * to get the typed effect list.
 *
 * `continue` is a degenerate terminal: it means no phase short-circuited
 * — i.e., we ran off the end of the pipeline without a classification.
 * The main pipeline doesn't produce this in practice (every phase either
 * `continue`s into the next phase or terminates), but the type keeps the
 * compose-and-short-circuit machinery symmetric with the dispatch side.
 */
export type PipelineResult<TOut extends BasePhaseCtx> = GenericPipelineResult<TOut, BounceTerminal>;

/**
 * A composed pipeline. Carries the input ctx type and the final output ctx
 * type so callers and tests can pass the right initial ctx.
 */
export type Pipeline<TIn extends BasePhaseCtx, TOut extends BasePhaseCtx> = GenericPipeline<
	PhaseDeps,
	BasePhaseCtx,
	TIn,
	TOut,
	BounceTerminal
>;

/**
 * Compose a list of phases into a Pipeline.
 *
 * The output ctx type of each phase must match the input ctx type of the
 * next; TypeScript catches a reordering bug at compile time via the
 * generic `Compose` helper.
 */
export function compose<
	const Phases extends readonly [Phase<BasePhaseCtx, BasePhaseCtx>, ...Array<Phase<BasePhaseCtx, BasePhaseCtx>>],
>(...phases: Phases): ComposedPipeline<PhaseDeps, BasePhaseCtx, BounceTerminal, Phases> {
	return composeGeneric<PhaseDeps, BasePhaseCtx, BounceTerminal, Phases>(...phases);
}

/**
 * Run a pipeline against a base ctx. Thin wrapper over `pipeline.run` for
 * symmetry with `applyEffects` / `reduce` at the call site.
 */
export function runPipeline<TIn extends BasePhaseCtx, TOut extends BasePhaseCtx>(
	deps: PhaseDeps,
	pipeline: Pipeline<TIn, TOut>,
	ctx: TIn,
): Promise<PipelineResult<TOut>> {
	return runPipelineGeneric(deps, pipeline, ctx);
}
