/**
 * Member erasure policy for the pending writes a member's own AI clients asked
 * for (`mcpPendingActions`, mcp/actions.ts), spread into `DESCENDANT_RELATIONS`
 * (descendantRelations.ts). Every reference a pending action holds goes with
 * the member, whatever it points at.
 */

import type { TableNames } from '../../_generated/dataModel';
import type { DescendantRelation } from './descendantRelations';

const MCP_ACTION = 'A write the member’s own AI client asked for; it goes with the member.';

const REFERENCES: ReadonlyArray<readonly [TableNames, string]> = [
	['mailboxes', 'mailboxId'],
	['mcpClients', 'clientId'],
	['mailDrafts', 'resultDraftId'],
	['mailDrafts', 'action.draftId'],
	['mailLabels', 'action.labelId'],
	['mailThreads', 'action.threadId'],
	['mailMessages', 'action.inReplyToMessageId'],
	['mailFolders', 'action.folderId'],
];

export const MCP_MEMBER_DESCENDANTS: readonly DescendantRelation[] = REFERENCES.map(
	([parent, field]) =>
		({
			parent,
			table: 'mcpPendingActions',
			field,
			action: 'delete',
			why: MCP_ACTION,
		}) satisfies DescendantRelation
);
