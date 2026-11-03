import { v } from 'convex/values';
import { literalUnion } from '../literalUnion';

/**
 * What an MCP client token may do. Only `read` exists: write tools need an
 * in-app approval step before they may run, and none ship yet.
 */
export const mcpClientAccessValidator = v.literal('read');

/** The read tools an MCP client can call; the activity log records which one ran. */
export const MCP_TOOL_NAMES = [
	'list_mailboxes',
	'list_folders',
	'list_labels',
	'search_mail',
	'read_thread',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export const mcpToolNameValidator = literalUnion(MCP_TOOL_NAMES);

/**
 * How one tool call ended: `ok`, `denied` (the client lost access to what it
 * asked for), `invalid` (bad arguments) or `error` (the server failed).
 */
export const mcpActivityOutcomeValidator = v.union(
	v.literal('ok'),
	v.literal('denied'),
	v.literal('invalid'),
	v.literal('error')
);
