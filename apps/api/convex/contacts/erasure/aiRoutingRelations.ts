/**
 * Contact erasure policy for the AI routing records
 * (schema/aiRouting.ts), spread into `CONTACT_RELATIONS` and
 * `DESCENDANT_RELATIONS` (relations.ts):
 *
 *  - a Team Inbox sender-memory entry names the sender's contact and goes with
 *    it (the `senderMemory` phase in `phases.ts`);
 *  - a decision artifact read from one of the contact's received messages goes
 *    with the message (`eraseInboundMessageDescendants` in `contentPhases.ts`).
 *
 * Postbox artifacts and memory hang off mailboxes and mail messages, which
 * contact erasure leaves alone; member erasure deletes them with the mailbox.
 */

import type { DescendantRelation, ErasureRelation } from './relations';

export const AI_ROUTING_CONTACT_RELATIONS: readonly ErasureRelation[] = [
	{
		table: 'senderMemory',
		field: 'contactId',
		action: 'delete',
		why: 'What the agent learned about how this person writes is derived from their mail; it is deleted, not unlinked, because an entry without its sender scope must not keep applying.',
	},
];

export const AI_ROUTING_CONTACT_DESCENDANTS: readonly DescendantRelation[] = [
	{
		parent: 'inboundMessages',
		table: 'decisionArtifacts',
		field: 'inboundMessageId',
		action: 'delete',
		why: 'The decision plane’s reading of the erased message (labels, scores, provenance).',
	},
];
