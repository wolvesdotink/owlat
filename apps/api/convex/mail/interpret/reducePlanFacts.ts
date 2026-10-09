/**
 * The reducer's fact decisions (brief mode, mail threads only), pure. Order
 * of precedence for one fact claim (review round 5 F6):
 *   1. IDENTITY: the fact this very claim produced before (its lineage,
 *      resolved in `fold.ts`), or else a current fact of the same key that
 *      rests only on this message (its earlier reading): merge the quotes,
 *      or, read again from its only source, take the new reading;
 *   2. a proven restatement of a current fact (`factEquivalence.ts`): merge;
 *   3. the relation the model names: a verified supersession retires the old
 *      fact, an unverified one or a contradiction is a conflict beside it;
 *   4. same key, not provably the same: a conflict (or, from the fact's only
 *      source, a replacement); otherwise a new fact.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import {
	interpretationSourceKey,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import type { ReduceEvidence, ReduceFact } from './reduceInput';
import { isProvenRestatement } from './factEquivalence';
import { newEvidence, type EvidenceRef } from './evidence';

/** The fact fields the plan reads. */
export type PlanFact = Pick<
	Doc<'threadFacts'>,
	'_id' | 'factKey' | 'status' | 'revision' | 'value' | 'redactedFields'
> & {
	evidence: readonly EvidenceRef[];
	/** The value with its sealed text opened, for comparison. */
	valueText?: string;
	/** Unsealed assertion, for the restatement check. */
	assertionText: string;
};

export type FactOp =
	| {
			kind: 'insert';
			/** Index in the result's `facts` (the fact's lineage). */
			index: number;
			fact: ReduceFact;
			supersedesId?: Id<'threadFacts'>;
			conflictsWithId?: Id<'threadFacts'>;
	  }
	| {
			kind: 'evidence';
			index: number;
			factId: Id<'threadFacts'>;
			addEvidence: ReduceEvidence[];
	  }
	/** A re-read of the fact's only source message: the new claim replaces it in place. */
	| { kind: 'replace'; index: number; factId: Id<'threadFacts'>; fact: ReduceFact }
	| { kind: 'supersede'; factId: Id<'threadFacts'> };

export interface FactPlanOptions {
	isOutOfOrder: boolean;
	source: InterpretationSource;
	factIdentity?: ReadonlyMap<number, string>;
}

export type FactDrop = { kind: 'fact'; index: number; reason: 'no_change' | 'out_of_order' };

/** Plan one message's fact claims. Pure. */
export function planFacts(
	stateFacts: readonly PlanFact[],
	facts: readonly ReduceFact[],
	contentRevision: string,
	opts: FactPlanOptions
): { ops: FactOp[]; dropped: FactDrop[] } {
	const ops: FactOp[] = [];
	const dropped: FactDrop[] = [];
	const state = { facts: stateFacts };
	const result = { facts };
	const current = state.facts.filter((f) => f.status === 'current');
	const currentById = new Map(current.map((f) => [f._id as string, f]));
	const retired = new Set<string>();
	const allById = new Map(state.facts.map((f) => [f._id as string, f]));
	const sourceKey = interpretationSourceKey(opts.source);
	const isOnlyFrom = (f: PlanFact) =>
		f.evidence.length > 0 &&
		f.evidence.every((e) => interpretationSourceKey(e.source) === sourceKey);
	/** Merge a repeat into `target`: its quotes, or, re-read from its only source, the new reading. */
	/** Facts a claim of this message already merged into (each takes one claim). */
	const claimed = new Set<string>();
	const merge = (index: number, fact: ReduceFact, target: PlanFact) => {
		claimed.add(target._id);
		// A fact a message purge redacted (purgeClaims.ts) takes the new claim whole.
		if (
			target.redactedFields?.length ||
			(!isProvenRestatement(fact, target) && isOnlyFrom(target))
		) {
			ops.push({ kind: 'replace', index, factId: target._id, fact });
			return;
		}
		const added = newEvidence(target.evidence, fact.evidence, opts.source, contentRevision);
		if (added.length > 0) {
			ops.push({ kind: 'evidence', index, factId: target._id, addEvidence: added });
		} else dropped.push({ kind: 'fact', index, reason: 'no_change' });
	};
	for (const [index, fact] of (result.facts ?? []).entries()) {
		// 1. Identity first (round 5 F6): the fact this very claim produced
		//    before (its lineage), whatever relation the model now names.
		//    A current same-key fact resting only on this message is its
		//    earlier reading (a repair reworded it): the same identity.
		const isOpen = (f: PlanFact) => !retired.has(f._id) && !claimed.has(f._id);
		const own =
			allById.get(opts.factIdentity?.get(index) ?? '') ??
			current.find((f) => f.factKey === fact.key && isOpen(f) && isOnlyFrom(f));
		if (own) {
			merge(index, fact, own);
			continue;
		}
		const named = (id: string | undefined) =>
			id && !retired.has(id) ? currentById.get(id) : undefined;
		const sameKeys = current.filter((f) => f.factKey === fact.key && isOpen(f));
		const sameKey = named(fact.matchFactId) ?? sameKeys[0];
		// 2. A proven restatement of any current fact merges, never conflicts.
		const restated = [named(fact.matchFactId), ...sameKeys].find(
			(f) => f !== undefined && isProvenRestatement(fact, f)
		);
		if (restated) {
			merge(index, fact, restated);
			continue;
		}
		// 3. Relations the model names.
		const superseded = named(fact.supersedes);
		const contradicted = named(fact.conflictsWith);
		if (superseded) {
			if (fact.isVerified && !opts.isOutOfOrder) {
				retired.add(superseded._id);
				ops.push({ kind: 'supersede', factId: superseded._id });
				ops.push({ kind: 'insert', index, fact, supersedesId: superseded._id });
			} else {
				ops.push({ kind: 'insert', index, fact, conflictsWithId: superseded._id });
				if (opts.isOutOfOrder) dropped.push({ kind: 'fact', index, reason: 'out_of_order' });
			}
			continue;
		}
		if (contradicted) {
			ops.push({ kind: 'insert', index, fact, conflictsWithId: contradicted._id });
			continue;
		}
		if (sameKey) {
			// Same key, not provably the same claim, nothing verified about
			// replacing it: a conflict to show, never a silent merge.
			ops.push({ kind: 'insert', index, fact, conflictsWithId: sameKey._id });
			continue;
		}
		ops.push({ kind: 'insert', index, fact });
	}
	return { ops, dropped };
}
