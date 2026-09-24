/**
 * Contact erasure relation policy — the declared fate of every row that points
 * at a contact when that contact is permanently deleted, and of every row that
 * points at something the erasure deletes.
 *
 * Pure data. The cascade itself is the phases in `phases.ts` and
 * `contentPhases.ts`; this file is the contract they implement.
 * `__tests__/contactErasureRelationCoverage.test.ts` seeds a row for every
 * `delete`/`unlink` relation and checks both erasure drivers clear it, and
 * `__tests__/contactErasureRelations.test.ts` walks the schema so a new
 * relation cannot land without a declaration here:
 *
 *   - every `v.id('contacts')` field anywhere in the schema (including nested
 *     and array fields) must appear in `CONTACT_RELATIONS`, and
 *   - every field that references a table the erasure deletes rows from must
 *     appear in `DESCENDANT_RELATIONS`, recursively.
 *
 * The three actions:
 *   - `delete` — the row is the person's data or meaningless without its
 *     parent. It goes, together with any blob it owns.
 *   - `unlink` — the row belongs to the organization and merely mentions the
 *     contact. The reference is removed and the row stays. `deletesWhen` names
 *     the case where the row is deleted instead.
 *   - `retain` — the row stays as it is. `why` must say why that is lawful and
 *     safe, or name the gap honestly when it is not handled yet.
 *
 * INDEPENDENTLY PROMOTED ORGANIZATION KNOWLEDGE IS RETAINED. An admin promoting
 * a learned clarification answer (`inbox/clarificationMemory.ts`
 * `promoteClarificationMemory`) clears its `contactId`: the row stops being a
 * fact about the person and becomes a standing answer for every sender. The
 * erasure finds rows through their contact reference, so a promoted answer is
 * out of its reach by construction and survives. The same holds for knowledge
 * entries that carry no contact link. This is a separate policy from the one
 * below, and it is why a contact-scoped answer must be DELETED rather than
 * unlinked: an absent `contactId` means organization-wide scope, so clearing
 * the reference would silently promote the erased person's answer to everyone.
 */

import type { TableNames } from '../../_generated/dataModel';

export type ErasureAction = 'delete' | 'unlink' | 'retain';

export interface ErasureRelation {
	/** Table holding the reference. */
	table: TableNames;
	/**
	 * Field path of the reference: `contactId`, `contactIds[]` for an array
	 * element, `a.b[].c` for a nested field.
	 */
	field: string;
	action: ErasureAction;
	/** For `unlink`: the case in which the row is deleted instead. */
	deletesWhen?: string;
	why: string;
}

export interface DescendantRelation extends ErasureRelation {
	/** The table whose deleted rows this field points at. */
	parent: TableNames;
}

/** Every field in the schema that references `contacts`. */
export const CONTACT_RELATIONS: readonly ErasureRelation[] = [
	{
		table: 'contactTopics',
		field: 'contactId',
		action: 'delete',
		why: 'Topic membership is the contact’s consent record; it means nothing without the contact.',
	},
	{
		table: 'contactPropertyValues',
		field: 'contactId',
		action: 'delete',
		why: 'Custom property values are attributes of the person.',
	},
	{
		table: 'contactActivities',
		field: 'contactId',
		action: 'delete',
		why: 'The activity timeline is the person’s behavioural history.',
	},
	{
		table: 'contactIdentities',
		field: 'contactId',
		action: 'delete',
		why: 'Channel identifiers are removed at soft-delete so the address is reclaimable at once; the purge sweeps anything left.',
	},
	{
		table: 'contactRelationships',
		field: 'fromContactId',
		action: 'delete',
		why: 'A relationship edge is meaningless with one end gone.',
	},
	{
		table: 'contactRelationships',
		field: 'toContactId',
		action: 'delete',
		why: 'A relationship edge is meaningless with one end gone.',
	},
	{
		table: 'automationRuns',
		field: 'contactId',
		action: 'delete',
		why: 'A run is one contact’s pass through an automation. It is terminated through the run lifecycle first, so the automation’s active total stays correct, and its step runs go with it.',
	},
	{
		table: 'emailSends',
		field: 'contactId',
		action: 'retain',
		why: 'Kept for campaign statistics, but soft-deleted and scrubbed of the recipient address and names. The suppression list is the lawful do-not-contact record.',
	},
	{
		table: 'transactionalSends',
		field: 'contactId',
		action: 'retain',
		why: 'Kept for delivery statistics, but soft-deleted and scrubbed of the address and the request-supplied template variables.',
	},
	{
		table: 'conversationThreads',
		field: 'contactId',
		action: 'delete',
		why: 'A thread with the contact is their correspondence; it goes with every message in it.',
	},
	{
		table: 'unifiedMessages',
		field: 'contactId',
		action: 'delete',
		why: 'Channel messages hold the person’s own words.',
	},
	{
		table: 'inboundMessages',
		field: 'contactId',
		action: 'delete',
		why: 'Received mail holds the person’s own words; the sealed raw message in storage is deleted with it.',
	},
	{
		table: 'formSubmissions',
		field: 'contactId',
		action: 'delete',
		why: 'Submitted form data is the person’s own data.',
	},
	{
		table: 'clarificationMemory',
		field: 'contactId',
		action: 'delete',
		why: 'A contact-scoped learned answer is personal data. Never unlinked: an absent contactId means organization-wide scope, so clearing it would promote the answer to every sender.',
	},
	{
		table: 'knowledgeEntries',
		field: 'contactIds[]',
		action: 'unlink',
		deletesWhen: 'the contact was the entry’s only subject',
		why: 'A fact extracted about the person alone is their data; a fact shared with other contacts only loses the link.',
	},
	{
		table: 'knowledgeEntryContacts',
		field: 'contactId',
		action: 'delete',
		why: 'The index-able mirror of knowledgeEntries.contactIds.',
	},
	{
		table: 'semanticFiles',
		field: 'contactIds[]',
		action: 'unlink',
		deletesWhen: 'it is an inbound capture scoped to nobody else',
		why: 'Organization documents only lose the link. A file the person attached to their own mail is their data and is deleted, bytes and all.',
	},
	{
		table: 'semanticFileContacts',
		field: 'contactId',
		action: 'delete',
		why: 'The index-able mirror of semanticFiles.contactIds.',
	},
	{
		table: 'contactErasureJobs',
		field: 'contactId',
		action: 'delete',
		why: 'The erasure’s own progress row; deleted in the same transaction as the contact row.',
	},
];

/**
 * Every field that references a table the erasure deletes rows from (a
 * `delete` relation above, or an `unlink` one with `deletesWhen`), recursively.
 */
export const DESCENDANT_RELATIONS: readonly DescendantRelation[] = [
	// ── automationRuns ──
	{
		parent: 'automationRuns',
		table: 'automationStepRuns',
		field: 'automationRunId',
		action: 'delete',
		why: 'Step runs are the run’s own execution record. In-flight ones are taken off the step’s pending/executing gauges as they go.',
	},

	// ── automationStepRuns ──
	{
		parent: 'automationStepRuns',
		table: 'transactionalSends',
		field: 'automationStepRunId',
		action: 'retain',
		why: 'An opaque idempotency key, not content; the Send itself is governed by its contactId (scrubbed above). Nothing dereferences it: the intake only looks it up by the id of a live step run, and ids are never reused, so the dangling key is inert. Keeping it means an email attempt still in flight during the erasure resolves to this Send instead of enqueuing a second one.',
	},

	// ── conversationThreads ──
	{
		parent: 'conversationThreads',
		table: 'unifiedMessages',
		field: 'threadId',
		action: 'delete',
		why: 'Every message in the thread goes, including organization replies that quote the person.',
	},
	{
		parent: 'conversationThreads',
		table: 'inboundMessages',
		field: 'threadId',
		action: 'retain',
		why: 'Governed by the message’s own contactId: the erased person’s mail is deleted through that relation, another sender’s mail in the same thread is theirs.',
	},
	{
		parent: 'conversationThreads',
		table: 'coalesceBatches',
		field: 'threadId',
		action: 'retain',
		why: 'Transient debounce row, consumed and deleted by its own scheduled job within the coalescing window.',
	},
	{
		parent: 'conversationThreads',
		table: 'threadPresence',
		field: 'threadId',
		action: 'retain',
		why: 'Ephemeral viewer heartbeat (user id and a timestamp), expired by the presence sweep.',
	},
	{
		parent: 'conversationThreads',
		table: 'threadReads',
		field: 'threadId',
		action: 'retain',
		why: 'A team member’s read marker: ids and a timestamp, no content.',
	},
	{
		parent: 'conversationThreads',
		table: 'inboxAssignmentNotices',
		field: 'threadId',
		action: 'retain',
		why: 'Known gap: the notice copies the thread subject, but the table has no index by thread to find it from here.',
	},
	{
		parent: 'conversationThreads',
		table: 'inboxFollowUps',
		field: 'threadId',
		action: 'delete',
		why: 'A follow-up is the team writing to the person on their thread; it goes with the thread like the replies in it. A pending one has its dispatch cancelled.',
	},
	{
		parent: 'conversationThreads',
		table: 'knowledgeEntries',
		field: 'threadId',
		action: 'retain',
		why: 'Governed by the entry’s contact links (contactIds[] above).',
	},
	{
		parent: 'conversationThreads',
		table: 'semanticFiles',
		field: 'threadId',
		action: 'retain',
		why: 'Governed by the file’s contact links (contactIds[] above).',
	},
	{
		parent: 'conversationThreads',
		table: 'visualizations',
		field: 'threadId',
		action: 'retain',
		why: 'An organization dashboard artifact that optionally names the thread it was asked from.',
	},
	{
		parent: 'conversationThreads',
		table: 'chatRooms',
		field: 'linkedInboxThreadId',
		action: 'retain',
		why: 'An internal team chat room; the optional link to the inbox thread is not the person’s data.',
	},

	// ── inboundMessages ──
	{
		parent: 'inboundMessages',
		table: 'agentActions',
		field: 'inboundMessageId',
		action: 'delete',
		why: 'The agent’s step inputs and outputs for the message: its reading of the person’s mail and the reply it drafted.',
	},
	{
		parent: 'inboundMessages',
		table: 'agentShadowDecisions',
		field: 'inboundMessageId',
		action: 'delete',
		why: 'Carries the sender address and a snapshot of the drafted reply.',
	},
	{
		parent: 'inboundMessages',
		table: 'autonomyFeedback',
		field: 'inboundMessageId',
		action: 'unlink',
		why: 'The review signal trains the organization’s autonomy rules and holds no message content; only the pointer to the erased message goes.',
	},
	{
		parent: 'inboundMessages',
		table: 'transactionalSends',
		field: 'inboundMessageId',
		action: 'retain',
		why: 'Governed by the send’s own contactId (scrubbed above).',
	},
	{
		parent: 'inboundMessages',
		table: 'knowledgeBackfillJobs',
		field: 'cursorId',
		action: 'retain',
		why: 'A walk position, not content: the backfill pages by (receivedAt, id) and only compares the id, it never loads the row.',
	},
	{
		parent: 'inboundMessages',
		table: 'coalesceBatches',
		field: 'leaderMessageId',
		action: 'retain',
		why: 'Transient debounce row, consumed and deleted by its own scheduled job within the coalescing window.',
	},
	{
		parent: 'inboundMessages',
		table: 'inboxAssignmentNotices',
		field: 'inboundMessageId',
		action: 'retain',
		why: 'Known gap: the notice copies the message subject, but the table has no index by message to find it from here.',
	},
	{
		parent: 'inboundMessages',
		table: 'inboxFollowUps',
		field: 'inReplyToMessageId',
		action: 'retain',
		why: 'Governed by the follow-up’s threadId: the erased person’s threads take their follow-ups with them. A pending follow-up whose message is gone fails at dispatch instead of sending.',
	},
	{
		parent: 'inboundMessages',
		table: 'codeWorkTasks',
		field: 'inboundMessageId',
		action: 'retain',
		why: 'An organization work item written by the team; the optional source pointer is not the person’s data.',
	},

	// ── inboxFollowUps ──
	{
		parent: 'inboxFollowUps',
		table: 'transactionalSends',
		field: 'followUpId',
		action: 'retain',
		why: 'Governed by the send’s own contactId (scrubbed above). When the send lands, the follow-up lifecycle finds no row and does nothing.',
	},

	// ── knowledgeEntries (deleted when the contact was the only subject) ──
	{
		parent: 'knowledgeEntries',
		table: 'knowledgeEntryContacts',
		field: 'entryId',
		action: 'delete',
		why: 'Junction rows of a deleted entry, including other contacts’ links.',
	},
	{
		parent: 'knowledgeEntries',
		table: 'knowledgeRelations',
		field: 'fromEntryId',
		action: 'delete',
		why: 'Graph edges out of a deleted entry.',
	},
	{
		parent: 'knowledgeEntries',
		table: 'knowledgeRelations',
		field: 'toEntryId',
		action: 'delete',
		why: 'Graph edges into a deleted entry.',
	},
	{
		parent: 'knowledgeEntries',
		table: 'knowledgeGraphStats',
		field: 'godNodes[].entryId',
		action: 'retain',
		why: 'A derived graph snapshot, rebuilt from the live graph by the recompute cron.',
	},
	{
		parent: 'knowledgeEntries',
		table: 'knowledgeGraphStats',
		field: 'surprisingConnections[].fromEntryId',
		action: 'retain',
		why: 'A derived graph snapshot, rebuilt from the live graph by the recompute cron.',
	},
	{
		parent: 'knowledgeEntries',
		table: 'knowledgeGraphStats',
		field: 'surprisingConnections[].toEntryId',
		action: 'retain',
		why: 'A derived graph snapshot, rebuilt from the live graph by the recompute cron.',
	},
	{
		parent: 'knowledgeEntries',
		table: 'knowledgeGraphStats',
		field: 'crossContactLinks[].fromEntryId',
		action: 'retain',
		why: 'A derived graph snapshot, rebuilt from the live graph by the recompute cron.',
	},
	{
		parent: 'knowledgeEntries',
		table: 'knowledgeGraphStats',
		field: 'crossContactLinks[].toEntryId',
		action: 'retain',
		why: 'A derived graph snapshot, rebuilt from the live graph by the recompute cron.',
	},

	// ── semanticFiles (deleted when a sole-contact inbound capture) ──
	{
		parent: 'semanticFiles',
		table: 'semanticFileContacts',
		field: 'fileId',
		action: 'delete',
		why: 'A deleted capture is scoped to nobody else, so its junction rows are the erased contact’s; any other one only exists through drift and goes with the file.',
	},
	{
		parent: 'semanticFiles',
		table: 'semanticFiles',
		field: 'previousVersionId',
		action: 'retain',
		why: 'A version pointer, not content. The version history walk stops at a missing row, so a deleted predecessor only ends the chain early.',
	},
	{
		parent: 'semanticFiles',
		table: 'inboundMessages',
		field: 'attachmentSuggestions.candidates[].fileId',
		action: 'retain',
		why: 'Known gap: an advisory suggestion snapshot on another message copies the file name and id; there is no index from a file to the messages that suggested it.',
	},
];

/** Tables whose rows the erasure may delete — the parents descendants hang off. */
export function tablesErasureDeletesFrom(): Set<TableNames> {
	const tables = new Set<TableNames>();
	for (const relation of [...CONTACT_RELATIONS, ...DESCENDANT_RELATIONS]) {
		if (relation.action === 'delete' || relation.deletesWhen !== undefined) {
			tables.add(relation.table);
		}
	}
	return tables;
}
