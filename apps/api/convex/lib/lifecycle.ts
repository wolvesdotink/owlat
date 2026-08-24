/**
 * Generic lifecycle core — the one layer every Owlat lifecycle module shares
 * verbatim.
 *
 * Eleven modules (`delivery/sendLifecycle`, `mail/postboxOutboundLifecycle`,
 * `mail/draftLifecycle`, `contacts/doiLifecycle`, `inbox/processingLifecycle`,
 * `transactional/lifecycle`, `campaigns/lifecycle`, `campaigns/abTestLifecycle`,
 * `automations/lifecycle`, `emailTemplates/lifecycle`, `domains/lifecycle`)
 * hand-roll the same `LEGAL_EDGES` graph plus the same five-line preamble of
 * their `dispatch`: look up the from-state's target set, test legality, test
 * the self-loop, optionally classify a no-outgoing-edges from-state as
 * `terminal`, otherwise refuse with `illegal_edge`.
 *
 * Scope is deliberately the *dispatcher only*. Reducers, effects, DB-reading
 * preconditions, external-key parsing, cross-machine coordination and every
 * module-local outcome literal stay in the module — they genuinely diverge and
 * pushing them behind a generic factor would be lossy. See
 * docs/adr/0058-generic-lifecycle-core.md.
 */

/**
 * Declarative edge graph: for each from-state, the states it may transition
 * to. A from-state with an empty target list is terminal.
 *
 * `TTo` defaults to `TFrom`, and is separate for the machines whose transition
 * targets are not all also from-states — `mail/draftLifecycle` reaches `sent`,
 * a target that is never persisted back as a draft state because the row is
 * deleted on arrival.
 */
export type LifecycleEdgeSpec<TFrom extends string, TTo extends string = TFrom> = Readonly<
	Record<TFrom, readonly TTo[]>
>;

/** The only two refusal reasons the core itself produces. */
export type LifecycleRefusalReason = 'illegal_edge' | 'terminal';

/**
 * Outcome-reason union for a module: the core's reasons plus the module's own
 * literals. This is the extension point that keeps module semantics intact —
 * e.g. `LifecycleReason<'unknown_mta_id_prefix' | 'recipient_not_found'>`.
 */
export type LifecycleReason<TExtra extends string = never> = LifecycleRefusalReason | TExtra;

/**
 * The classification of one attempted edge.
 *
 * `proceed` means the caller may run its reducer. `isSelfLoop` is reported
 * alongside rather than as its own kind because a self-loop is orthogonal to
 * legality: several machines declare a self-edge legal, and several allow a
 * self-loop that the graph does not declare (the reducer answers `recorded`).
 * Callers that gate a precondition on "not already there" read `isSelfLoop`.
 */
export type TransitionVerdict<TFrom extends string, TTo extends string = TFrom> =
	| {
			readonly kind: 'proceed';
			readonly from: TFrom;
			readonly to: TTo;
			readonly isSelfLoop: boolean;
	  }
	| {
			readonly kind: 'refused';
			readonly reason: LifecycleRefusalReason;
			readonly from: TFrom;
			readonly to: TTo;
	  };

/** The refused arm of {@link TransitionVerdict}. */
export type RefusedVerdict<TFrom extends string, TTo extends string = TFrom> = Extract<
	TransitionVerdict<TFrom, TTo>,
	{ kind: 'refused' }
>;

/** The shared refusal shape every module's `ok: false` outcome extends. */
export type LifecycleRefusal<TFrom extends string, TTo extends string = TFrom> = {
	readonly ok: false;
	readonly reason: LifecycleRefusalReason;
	readonly from: TFrom;
	readonly to: TTo;
};

export type ClassifyOptions = {
	/**
	 * Force-legal escape hatch for an edge the module sanctions on grounds the
	 * graph cannot express — e.g. the DOI machine relaxes
	 * `not_required → confirmed` when, and only when, the input carries
	 * `source: 'admin_attest'`. Defaults to `false`.
	 */
	readonly isSanctionedEdge?: boolean;
};

export type LifecycleOptions = {
	/**
	 * Opt in to `terminal` refusals. OFF by default: only five of the eleven
	 * lifecycle modules distinguish "refused because the from-state has no
	 * outgoing edges" from a plain illegal edge, and the other six must keep
	 * answering `illegal_edge` there. Forcing the richer reason on them would
	 * widen their published outcome unions.
	 */
	readonly reportsTerminalRefusals?: boolean;
};

export type LifecycleGraph<TFrom extends string, TTo extends string = TFrom> = {
	/** Every declared from-state, in declaration order. */
	readonly states: readonly TFrom[];
	/** Whether this machine reports `terminal` refusals (see LifecycleOptions). */
	readonly reportsTerminalRefusals: boolean;
	/** The legal targets of `from`; empty for a terminal or undeclared state. */
	legalTargets(from: TFrom): ReadonlySet<TTo>;
	/** Whether `from → to` is declared in the graph. */
	isLegalEdge(from: TFrom, to: TTo): boolean;
	/** Whether `state` is declared and has no outgoing edges. */
	isTerminal(state: TFrom): boolean;
	/** Classify one attempted edge. The whole point of this module. */
	classify(from: TFrom, to: TTo, options?: ClassifyOptions): TransitionVerdict<TFrom, TTo>;
};

const NO_TARGETS: ReadonlySet<string> = new Set<string>();

/**
 * Build a lifecycle graph from a declarative edge spec.
 *
 * ```ts
 * const RECIPIENT_LIFECYCLE = defineLifecycle<RecipientState>(
 *   { queued: ['sent', 'bounced', 'failed'], sent: ['bounced'], bounced: [], failed: [] },
 *   { reportsTerminalRefusals: true }
 * );
 * ```
 */
export function defineLifecycle<TFrom extends string, TTo extends string = TFrom>(
	spec: LifecycleEdgeSpec<TFrom, TTo>,
	options: LifecycleOptions = {}
): LifecycleGraph<TFrom, TTo> {
	const states = Object.keys(spec) as TFrom[];
	const edges = new Map<TFrom, ReadonlySet<TTo>>(
		states.map((from) => [from, new Set<TTo>(spec[from])] as const)
	);
	const reportsTerminalRefusals = options.reportsTerminalRefusals ?? false;

	// An undeclared from-state (a row written before a state literal existed, or
	// a cast that outran the schema) has no targets and is never "terminal" —
	// it refuses as `illegal_edge` rather than crashing on `undefined.has(...)`,
	// which is what the hand-rolled `LEGAL_EDGES[from].has(to)` did.
	const legalTargets = (from: TFrom): ReadonlySet<TTo> =>
		edges.get(from) ?? (NO_TARGETS as ReadonlySet<TTo>);

	const isLegalEdge = (from: TFrom, to: TTo): boolean => legalTargets(from).has(to);

	const isTerminal = (state: TFrom): boolean => {
		const targets = edges.get(state);
		return targets !== undefined && targets.size === 0;
	};

	const classify = (
		from: TFrom,
		to: TTo,
		classifyOptions: ClassifyOptions = {}
	): TransitionVerdict<TFrom, TTo> => {
		const isSelfLoop = (from as string) === (to as string);
		if (isLegalEdge(from, to) || classifyOptions.isSanctionedEdge === true || isSelfLoop) {
			return { kind: 'proceed', from, to, isSelfLoop };
		}
		if (reportsTerminalRefusals && isTerminal(from)) {
			return { kind: 'refused', reason: 'terminal', from, to };
		}
		return { kind: 'refused', reason: 'illegal_edge', from, to };
	};

	return {
		states,
		reportsTerminalRefusals,
		legalTargets,
		isLegalEdge,
		isTerminal,
		classify,
	};
}

/**
 * Turn a refused verdict into a module outcome, folding in whatever
 * module-local context that module's `ok: false` shape carries (row ids, an
 * array index, …). The returned `reason` is one of the core's two literals; a
 * module whose union is wider (`LifecycleReason<'unknown_mta_id_prefix'>`)
 * accepts it unchanged.
 */
export function refuse<TFrom extends string, TTo extends string>(
	verdict: RefusedVerdict<TFrom, TTo>
): LifecycleRefusal<TFrom, TTo>;
export function refuse<TFrom extends string, TTo extends string, TContext extends object>(
	verdict: RefusedVerdict<TFrom, TTo>,
	context: TContext
): LifecycleRefusal<TFrom, TTo> & TContext;
export function refuse<TFrom extends string, TTo extends string>(
	verdict: RefusedVerdict<TFrom, TTo>,
	context: object = {}
): LifecycleRefusal<TFrom, TTo> {
	return {
		ok: false,
		reason: verdict.reason,
		from: verdict.from,
		to: verdict.to,
		...context,
	};
}
