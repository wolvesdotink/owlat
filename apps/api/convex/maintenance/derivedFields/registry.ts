/**
 * THE DERIVED-FIELD REGISTRY: every field the schema labels `AGGREGATED` (a
 * cache of other rows) or `COUNTER` (the only record of its events), and what
 * each one is made of.
 *
 * A derived entry (`./adapters.ts`) recomputes the field for one parent row; the
 * hourly sampler (`./sampler.ts`) visits a few parents per field in turn, logs
 * the ones whose cache differs from the recount and repairs them. A counter
 * entry below says why its field has no recount.
 *
 * `__tests__/derivedFieldRegistry.test.ts` holds the two in step with the
 * source: a label without a registered `[id]`, an id under the wrong label, a
 * label that does not sit on the fields its entry names, or an entry whose
 * fields are not in the schema, fails it. So a new cached field cannot ship
 * without a recount, and moving a field from one label to the other is a
 * reviewed change to this file.
 */

import { counter, type CounterFieldEntry, type RegistryEntry } from './types';
import { DERIVED_FIELD_ENTRIES } from './adapters';

const COUNTER_FIELD_ENTRIES: readonly CounterFieldEntry[] = [
	counter({
		kind: 'counter',
		id: 'campaignUnsubscribes',
		table: 'campaigns',
		fields: ['statsUnsubscribed'],
		why:
			'One bump per unsubscribe attributed to the campaign (topics/subscription.ts ' +
			'recordCampaignUnsubscribe), including a contact who leaves again after re-subscribing. ' +
			'The send row keeps only the first unsubscribe, so the sends undercount it.',
	}),
	counter({
		kind: 'counter',
		id: 'assistantConversationActivity',
		table: 'aiConversations',
		fields: ['lastMessageAt'],
		why:
			'Moves when a turn is sent and again when the assistant reply finishes; the finish time ' +
			'is stored nowhere else, so the messages cannot reproduce it.',
	}),
	counter({
		kind: 'counter',
		id: 'savedReplyUsage',
		table: 'mailSnippets',
		fields: ['useCount', 'lastUsedAt'],
		why: 'Each insertion of a saved reply bumps the row and records no event of its own.',
	}),
	counter({
		kind: 'counter',
		id: 'importSuppressionTally',
		table: 'integrationImports',
		fields: ['suppressionCounts'],
		why:
			"The run's report of what its walker did with each suppression, page by page. Several " +
			'outcomes (already blocked, no contact, skipped) write no row, and the rows the others ' +
			'write do not name the run.',
	}),
	counter({
		kind: 'counter',
		id: 'mailboxMigrationProgress',
		table: 'mailboxMigrations',
		fields: ['messagesTotal', 'messagesImported', 'messagesFailed', 'messagesIndexed'],
		why:
			'Progress of one walk as the worker and the indexer report it; a stored message does not ' +
			'say which walk stored it, and a failed one leaves no row at all.',
	}),
	counter({
		kind: 'counter',
		id: 'threadResponseMetrics',
		table: 'conversationThreads',
		fields: ['firstResponseAt', 'resolvedAt', 'slaMetCount', 'slaMissedCount'],
		why:
			'Stamped and counted when a reply or a resolve happens, judged against the response ' +
			'target in force at that moment. Targets change and the audit rows of a resolve age out, ' +
			'so no later read can judge a reply again.',
	}),
	counter({
		kind: 'counter',
		id: 'smtpResponseCategoryCounts',
		table: 'smtpResponseCategories',
		fields: ['byCategory'],
		why: 'Receiver responses are counted as they arrive and are not stored one by one.',
	}),
];

export const DERIVED_FIELD_REGISTRY: readonly RegistryEntry[] = [
	...DERIVED_FIELD_ENTRIES,
	...COUNTER_FIELD_ENTRIES,
];
