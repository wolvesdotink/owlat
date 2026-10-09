/**
 * What a claim would change on an item it may not change directly, held
 * apart as the item's `pendingUpdate` ("Check this change") until a person
 * confirms it (`reactionRules.ts confirmProposal`), pure.
 *
 *   - An unconfirmed claim on a tracked item: the deadline, amount and options
 *     it names that differ.
 *   - A verified claim on an item a person CONFIRMED (review round 6 F4): every
 *     confirmed field is compared, and any difference is held:
 *       - the deadline, amount and options it names that differ;
 *       - its parties and responsibility (any message may change who owes it);
 *       - from a message already behind the item (a re-read, a repair): its
 *         wording and display, and the deadline, amount or options it no
 *         longer has (`removes`). Another message's wording or silence is not
 *         a change of the obligation.
 */

import type { Doc } from '../../_generated/dataModel';
import type { ReduceEvidence, ReduceItem } from './reduceInput';
import { responsibilityOf } from './parties';

type Party = Doc<'threadItems'>['requester'];
type Removable = 'due' | 'amount' | 'options';

/** A held update as the plan hands it to the fold (plaintext wording). */
export interface PlanHeld {
	addEvidence: ReduceEvidence[];
	due?: Doc<'threadItems'>['due'];
	amount?: Doc<'threadItems'>['amount'];
	options?: string[];
	assertion?: string;
	display?: { en: string; de: string };
	requester?: Party;
	responsible?: Party;
	beneficiary?: Party;
	responsibility?: Doc<'threadItems'>['responsibility'];
	removes?: Removable[];
}

/** The item fields the comparison reads. */
export interface HeldTarget {
	due?: Doc<'threadItems'>['due'];
	amount?: Doc<'threadItems'>['amount'];
	options?: string[];
	assertionText: string;
	storedDisplay?: { en: string; de: string };
	requester?: Party;
	responsible?: Party;
	beneficiary?: Party;
	responsibility?: Doc<'threadItems'>['responsibility'];
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Two references to the same person (the address, else the name, and the side). */
function sameParty(a: Party | undefined, b: Party | undefined): boolean {
	if (!a || !b) return !a && !b;
	const key = (p: Party) => `${p.isUs}|${(p.email ?? p.name ?? '').trim().toLowerCase()}`;
	return key(a) === key(b);
}

/**
 * The held update `proposal` makes to `target`, or null when it changes
 * nothing. `isConfirmed`: every confirmed field is compared (see the module
 * doc); `isSeenSource`: the claim comes from a message already behind it.
 */
export function heldUpdateOf(
	proposal: ReduceItem,
	target: HeldTarget,
	added: ReduceEvidence[],
	opts: { isConfirmed: boolean; isSeenSource: boolean }
): PlanHeld | null {
	const held: PlanHeld = { addEvidence: added };
	if (proposal.due && !same(proposal.due, target.due)) held.due = proposal.due;
	if (proposal.amount && !same(proposal.amount, target.amount)) held.amount = proposal.amount;
	if (proposal.options && !same(proposal.options, target.options)) held.options = proposal.options;
	if (opts.isConfirmed) {
		if (target.requester && !sameParty(proposal.requester, target.requester)) {
			held.requester = proposal.requester;
		}
		if (target.responsible && !sameParty(proposal.responsible, target.responsible)) {
			held.responsible = proposal.responsible;
		}
		if (proposal.beneficiary && !sameParty(proposal.beneficiary, target.beneficiary)) {
			held.beneficiary = proposal.beneficiary;
		}
		const responsibility = responsibilityOf(proposal.responsible);
		if (target.responsibility && responsibility !== target.responsibility) {
			held.responsibility = responsibility;
		}
		if (opts.isSeenSource) {
			if (
				proposal.assertion !== target.assertionText ||
				(target.storedDisplay && !same(proposal.display, target.storedDisplay))
			) {
				held.assertion = proposal.assertion;
				held.display = proposal.display;
			}
			const removes: Removable[] = [];
			if (!proposal.due && target.due) removes.push('due');
			if (!proposal.amount && target.amount) removes.push('amount');
			if (!proposal.options && target.options) removes.push('options');
			if (removes.length > 0) held.removes = removes;
		}
	}
	const { addEvidence, ...changes } = held;
	return addEvidence.length > 0 || Object.keys(changes).length > 0 ? held : null;
}
