/**
 * Generic phase pipeline — the ordered, short-circuiting check sequence
 * shared by the dispatch (ADR-0007) and bounce-intake pipelines.
 *
 * A Phase is a typed step `Phase<TIn, TOut>` whose input/output ctx threads
 * forward into the next phase. The runner short-circuits on the first
 * non-`continue` outcome (a "terminal") and attributes it to the phase that
 * emitted it; otherwise it threads the enriched ctx into the next phase and,
 * if no phase short-circuits, returns `continue` with the final ctx.
 *
 * Both pipelines reuse this machinery; they differ only in the terminal
 * outcome vocabulary they parameterize it over:
 *   - dispatch: `defer` / `drop`
 *   - bounce:   `dropSilently` / `bounceTo`
 *
 * Each terminal outcome carries no `phase` field; the runner appends one to
 * the result it returns. A terminal is any outcome whose `kind` is not
 * `'continue'`.
 */

/**
 * A terminal outcome — anything a phase can emit that ends the pipeline.
 * Constrained to be a `{ kind }`-discriminated record so the runner can tell
 * it apart from `continue`, and so it can append a `phase` attribution.
 */
export type TerminalOutcome = { readonly kind: string };

/**
 * Outcome a phase emits per execution.
 *
 * - `continue` carries the ctx for the next phase. Most phases pass it
 *   through unchanged (`Phase<X, X>`); enriching phases widen the ctx type.
 * - any `Term` member ends the attempt; the runner attributes it to the
 *   emitting phase.
 */
export type PhaseOutcome<TOut, Term extends TerminalOutcome> =
	| { kind: 'continue'; ctx: TOut }
	| Term;

/**
 * One step in the pipeline. The runner discovers the step's name via this
 * record so logs and telemetry can attribute terminals to the phase that
 * emitted them.
 */
export interface Phase<Deps, TIn, TOut, Term extends TerminalOutcome> {
	readonly name: string;
	run(deps: Deps, ctx: TIn): Promise<PhaseOutcome<TOut, Term>>;
}

/**
 * The pipeline's collected output. Mirrors `PhaseOutcome` but is what the
 * runner returns — every terminal is widened with the emitting phase's name.
 */
export type PipelineResult<TOut, Term extends TerminalOutcome> =
	| { kind: 'continue'; ctx: TOut }
	| (Term & { phase: string });

/**
 * A composed pipeline. Carries the input ctx type and the final output ctx
 * type so callers and tests can pass the right initial ctx.
 */
export interface Pipeline<Deps, Base, TIn extends Base, TOut extends Base, Term extends TerminalOutcome> {
	readonly phases: ReadonlyArray<Phase<Deps, Base, Base, Term>>;
	run(deps: Deps, ctx: TIn): Promise<PipelineResult<TOut, Term>>;
}

/**
 * Type-level chain walker.
 *
 * Given a tuple of phases, recursively pairs adjacent phases and requires
 * the first's `TOut` to be assignable to the second's `TIn`. On each step,
 * the two phases are conceptually "merged" into a `Phase<…, A, D, …>` that
 * stands in for the rest of the chain. When the tuple collapses to one
 * phase, that phase is the composed result.
 *
 * If any pair fails the assignability check, the result is `never` and the
 * `compose(...)` call site fails to type-check — a reordered phase is a
 * compile error.
 */
type Compose<Deps, Term extends TerminalOutcome, P> = P extends readonly [infer Only]
	? Only
	: P extends readonly [
				Phase<Deps, infer A, infer B, Term>,
				Phase<Deps, infer C, infer D, Term>,
				...infer Rest,
			]
		? B extends C
			? Rest extends ReadonlyArray<Phase<Deps, unknown, unknown, Term>>
				? Compose<Deps, Term, readonly [Phase<Deps, A, D, Term>, ...Rest]>
				: never
			: never
		: never;

export type ComposedPipeline<Deps, Base, Term extends TerminalOutcome, P> =
	Compose<Deps, Term, P> extends Phase<Deps, infer TIn, infer TOut, Term>
		? TIn extends Base
			? TOut extends Base
				? Pipeline<Deps, Base, TIn, TOut, Term>
				: never
			: never
		: never;

/**
 * Compose a list of phases into a Pipeline.
 *
 * The output ctx type of each phase must match the input ctx type of the
 * next; TypeScript catches a reordering bug at compile time via the
 * `Compose` helper. The runner short-circuits on the first non-`continue`
 * outcome and stamps it with the emitting phase's name.
 */
export function compose<
	Deps,
	Base,
	Term extends TerminalOutcome,
	const Phases extends readonly [
		Phase<Deps, Base, Base, Term>,
		...Array<Phase<Deps, Base, Base, Term>>,
	],
>(...phases: Phases): ComposedPipeline<Deps, Base, Term, Phases> {
	const list = phases as ReadonlyArray<Phase<Deps, Base, Base, Term>>;

	const pipeline: Pipeline<Deps, Base, Base, Base, Term> = {
		phases: list,
		async run(deps, ctx) {
			let current: Base = ctx;
			for (const phase of list) {
				const outcome = await phase.run(deps, current);
				if (outcome.kind === 'continue') {
					current = (outcome as { kind: 'continue'; ctx: Base }).ctx;
					continue;
				}
				return { ...(outcome as Term), phase: phase.name } as PipelineResult<Base, Term>;
			}
			return { kind: 'continue', ctx: current };
		},
	};

	return pipeline as ComposedPipeline<Deps, Base, Term, Phases>;
}

/**
 * Run a pipeline against a base ctx. Thin wrapper over `pipeline.run` for
 * symmetry with `applyEffects` / `reduce` at the call site.
 */
export async function runPipeline<
	Deps,
	Base,
	TIn extends Base,
	TOut extends Base,
	Term extends TerminalOutcome,
>(
	deps: Deps,
	pipeline: Pipeline<Deps, Base, TIn, TOut, Term>,
	ctx: TIn,
): Promise<PipelineResult<TOut, Term>> {
	return pipeline.run(deps, ctx);
}
