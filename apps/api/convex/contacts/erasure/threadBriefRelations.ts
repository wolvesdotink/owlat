/**
 * Contact erasure policy for the thread brief tables (schema/threadBrief.ts),
 * spread into `DESCENDANT_RELATIONS` (relations.ts).
 *
 * KNOWN GAP, declared as `retain` until the thread brief erasure lands: the
 * rows below are derived from the erased person's team thread and messages,
 * and must go with them. The erasure phases for them are part of the thread
 * brief wiring; that change flips each entry to `delete` together with its
 * phase, which `contactErasureRelationCoverage.test.ts` then checks.
 */

import type { TableNames } from '../../_generated/dataModel';
import { THREAD_BRIEF_TABLES } from '../../schema/threadBrief';
import type { DescendantRelation } from './relations';

const GAP =
	'Known gap (thread brief): derived from the thread’s mail; the erasure phase that deletes it lands with the thread brief wiring.';

const relation = (parent: TableNames, table: TableNames, field: string): DescendantRelation => ({
	parent,
	table,
	field,
	action: 'retain',
	why: GAP,
});

export const THREAD_BRIEF_CONTACT_DESCENDANTS: readonly DescendantRelation[] = [
	...THREAD_BRIEF_TABLES.map((table) =>
		relation('conversationThreads', table, 'conversationThreadId')
	),
	relation('inboundMessages', 'messageInterpretations', 'source.id'),
	relation('inboundMessages', 'interpretSources', 'source.id'),
	relation('inboundMessages', 'threadFacts', 'evidence[].source.id'),
	relation('inboundMessages', 'threadItems', 'evidence[].source.id'),
	relation('inboundMessages', 'draftResponsePlans', 'inboundMessageId'),
];
