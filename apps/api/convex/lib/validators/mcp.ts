import { v, type Infer } from 'convex/values';
import { literalUnion } from '../literalUnion';

/**
 * What an MCP client token may do. `read` searches and reads. `read_write`
 * may also ask for the write tools, and each write waits as a pending action
 * until the token's owner approves it in Owlat (`mcp/actions.ts`).
 */
export const MCP_CLIENT_ACCESS = ['read', 'read_write'] as const;
export type McpClientAccess = (typeof MCP_CLIENT_ACCESS)[number];
export const mcpClientAccessValidator = literalUnion(MCP_CLIENT_ACCESS);

/** The tools any token may call. `get_action_status` only means something to a read-write token. */
export const MCP_READ_TOOL_NAMES = [
	'list_mailboxes',
	'list_folders',
	'list_labels',
	'search_mail',
	'read_thread',
	'get_action_status',
] as const;

/** The tools that change mail. None of them runs before the owner approves it. */
export const MCP_WRITE_TOOL_NAMES = [
	'create_draft',
	'send_draft',
	'archive_thread',
	'move_thread',
	'label_thread',
] as const;

/** Every tool an MCP client can call; the activity log records which one ran. */
export const MCP_TOOL_NAMES = [...MCP_READ_TOOL_NAMES, ...MCP_WRITE_TOOL_NAMES] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
export type McpWriteToolName = (typeof MCP_WRITE_TOOL_NAMES)[number];

export const mcpToolNameValidator = literalUnion(MCP_TOOL_NAMES);

export function isMcpWriteTool(name: McpToolName): name is McpWriteToolName {
	return (MCP_WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * How one tool call, or one step of a write, ended: `ok`, `denied` (the client
 * lost access to what it asked for), `invalid` (bad arguments), `error` (the
 * server failed, or an approved write could not run). A write adds a row when
 * it is asked for (`pending_approval`) and one when it leaves that state
 * (`approved`, `rejected`, `expired`, `cancelled`).
 */
export const mcpActivityOutcomeValidator = v.union(
	v.literal('ok'),
	v.literal('denied'),
	v.literal('invalid'),
	v.literal('error'),
	v.literal('pending_approval'),
	v.literal('approved'),
	v.literal('rejected'),
	v.literal('expired'),
	v.literal('cancelled')
);
export type McpActivityOutcome = Infer<typeof mcpActivityOutcomeValidator>;

/**
 * Where a write waiting for approval stands. `approved` ran, `failed` was
 * approved but could not run (access gone, the draft already sent, ...),
 * `cancelled` went with its revoked token.
 */
export const MCP_ACTION_STATUSES = [
	'pending',
	'approved',
	'rejected',
	'expired',
	'failed',
	'cancelled',
] as const;
export type McpActionStatus = (typeof MCP_ACTION_STATUSES)[number];
export const mcpActionStatusValidator = literalUnion(MCP_ACTION_STATUSES);

/**
 * One write a client asked for, with its targets already checked against the
 * mailbox when it was asked. Approval checks them again.
 */
export const mcpActionValidator = v.union(
	v.object({
		tool: v.literal('create_draft'),
		to: v.array(v.string()),
		cc: v.array(v.string()),
		subject: v.string(),
		body: v.string(),
		inReplyToMessageId: v.optional(v.id('mailMessages')),
	}),
	v.object({ tool: v.literal('send_draft'), draftId: v.id('mailDrafts') }),
	v.object({ tool: v.literal('archive_thread'), threadId: v.id('mailThreads') }),
	v.object({
		tool: v.literal('move_thread'),
		threadId: v.id('mailThreads'),
		folderId: v.id('mailFolders'),
	}),
	v.object({
		tool: v.literal('label_thread'),
		threadId: v.id('mailThreads'),
		labelId: v.id('mailLabels'),
		add: v.boolean(),
	})
);
export type McpAction = Infer<typeof mcpActionValidator>;
