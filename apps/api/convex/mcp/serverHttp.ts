/**
 * `POST /mcp/postbox`: the Postbox MCP server over the Streamable HTTP
 * transport, stateless, one JSON-RPC message per request, answered as JSON.
 *
 * The bearer token is an MCP client token (`mcp/clients.ts`), never a session
 * cookie or an API key. A request that carries an `Origin` header is refused:
 * MCP clients are desktop and server programs, and refusing browsers keeps a
 * web page from driving the endpoint (the transport spec asks servers to
 * guard against exactly that). The route answers no CORS preflight for the
 * same reason.
 */

import { internal } from '../_generated/api';
import { httpAction, type ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { extractApiKey, hashApiKey } from '../auth/apiKeyAuth';
import { getClientIp } from '../lib/publicRateLimit';
import { logError } from '../lib/runtimeLog';
import {
	MCP_TOKEN_PREFIX,
	RPC_INTERNAL_ERROR,
	RPC_INVALID_REQUEST,
	RPC_METHOD_NOT_FOUND,
	RPC_PARSE_ERROR,
	actionResult,
	classifyRpcMessage,
	initializeResult,
	isAcceptableProtocolHeader,
	isToolAllowed,
	parseToolCall,
	rpcError,
	rpcResult,
	toolError,
	toolResult,
	toolDefinitionsFor,
	type ToolArgs,
	type WriteToolArgs,
} from './protocol';
import { isMcpWriteTool, type McpClientAccess } from '../lib/validators/mcp';
import type { ToolOutcome } from './reads';

const READ_ONLY_MESSAGE =
	'This connection is read-only. Its owner can connect a read-write client in Owlat.';

/** One JSON-RPC message is small; anything bigger is not a request we serve. */
const MAX_BODY_BYTES = 64 * 1024;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	});
}

function unauthorized(message: string): Response {
	return json(rpcError(null, RPC_INVALID_REQUEST, message), 401, {
		'WWW-Authenticate': 'Bearer realm="owlat-mcp"',
	});
}

type ReadToolArgs = Exclude<ToolArgs, WriteToolArgs>;

function isWriteCall(call: ToolArgs): call is WriteToolArgs {
	return isMcpWriteTool(call.tool);
}

function runTool(
	ctx: ActionCtx,
	clientId: Id<'mcpClients'>,
	call: ReadToolArgs
): Promise<ToolOutcome> {
	switch (call.tool) {
		case 'list_mailboxes':
			return ctx.runQuery(internal.mcp.reads.listMailboxes, { clientId });
		case 'list_folders':
			return ctx.runQuery(internal.mcp.reads.listFolders, { clientId, mailboxId: call.mailboxId });
		case 'list_labels':
			return ctx.runQuery(internal.mcp.reads.listLabels, { clientId, mailboxId: call.mailboxId });
		case 'search_mail':
			return ctx.runQuery(internal.mcp.reads.searchMail, {
				clientId,
				query: call.query,
				limit: call.limit,
				...(call.mailboxId !== undefined ? { mailboxId: call.mailboxId } : {}),
				...(call.cursor !== undefined ? { cursor: call.cursor } : {}),
			});
		case 'read_thread':
			return ctx.runQuery(internal.mcp.reads.readThread, {
				clientId,
				messageId: call.messageId,
				maxMessages: call.maxMessages,
			});
		case 'get_action_status':
			return ctx.runQuery(internal.mcp.actions.getStatus, { clientId, actionId: call.actionId });
	}
}

/** Ask for a write: one mutation checks it, records it and logs the step. */
async function proposeWrite(
	ctx: ActionCtx,
	clientId: Id<'mcpClients'>,
	request: WriteToolArgs
): Promise<{ ok: true; result: unknown }> {
	try {
		const outcome = await ctx.runMutation(internal.mcp.actions.propose, { clientId, request });
		return {
			ok: true,
			result: outcome.status === 'ok' ? actionResult(outcome.payload) : toolError(outcome.message),
		};
	} catch (error) {
		logError('[MCP] write request failed', { tool: request.tool, clientId, error: String(error) });
		return { ok: true, result: toolError('The tool failed. Try again later.') };
	}
}

/** Run one `tools/call`, log it, and build the JSON-RPC result. */
async function callTool(
	ctx: ActionCtx,
	clientId: Id<'mcpClients'>,
	access: McpClientAccess,
	params: Record<string, unknown>
): Promise<{ ok: true; result: unknown } | { ok: false; code: number; message: string }> {
	const parsed = parseToolCall(params);
	// A tool this token is not shown (a write, for a read token) is refused and
	// logged, so the owner sees the attempt. `propose` checks the stored access
	// again on its own.
	const tool = parsed.ok ? parsed.call.tool : parsed.tool;
	if (tool && !isToolAllowed(access, tool)) {
		await ctx.runMutation(internal.mcp.activity.record, { clientId, tool, outcome: 'denied' });
		return { ok: true, result: toolError(READ_ONLY_MESSAGE) };
	}
	if (!parsed.ok) {
		if (!parsed.tool) return { ok: false, code: parsed.code, message: parsed.message };
		await ctx.runMutation(internal.mcp.activity.record, {
			clientId,
			tool: parsed.tool,
			outcome: 'invalid',
		});
		return { ok: true, result: toolError(parsed.message) };
	}
	const { call } = parsed;
	if (isWriteCall(call)) return proposeWrite(ctx, clientId, call);
	let outcome: ToolOutcome | null = null;
	try {
		outcome = await runTool(ctx, clientId, call);
	} catch (error) {
		logError('[MCP] tool failed', { tool: call.tool, clientId, error: String(error) });
	}
	await ctx.runMutation(internal.mcp.activity.record, {
		clientId,
		tool: call.tool,
		outcome: outcome?.status ?? 'error',
		...outcome?.audit,
		...(call.tool === 'search_mail' ? { query: call.query } : {}),
	});
	if (!outcome) return { ok: true, result: toolError('The tool failed. Try again later.') };
	return {
		ok: true,
		result:
			outcome.status !== 'ok'
				? toolError(outcome.message)
				: outcome.isAction
					? actionResult(outcome.payload)
					: toolResult(outcome.payload),
	};
}

export const postboxMcp = httpAction(async (ctx, request) => {
	if (request.headers.get('Origin') !== null) {
		return json(
			rpcError(null, RPC_INVALID_REQUEST, 'Requests from web pages are not accepted.'),
			403
		);
	}
	const token = extractApiKey(request);
	if (!token || !token.startsWith(MCP_TOKEN_PREFIX)) {
		return unauthorized('Missing or malformed bearer token.');
	}
	if (!isAcceptableProtocolHeader(request.headers.get('MCP-Protocol-Version'))) {
		return json(rpcError(null, RPC_INVALID_REQUEST, 'Unsupported MCP-Protocol-Version.'), 400);
	}
	const declaredLength = Number(request.headers.get('Content-Length') ?? '0');
	if (declaredLength > MAX_BODY_BYTES) {
		return json(rpcError(null, RPC_INVALID_REQUEST, 'Request body too large.'), 413);
	}

	// checkpoint: the rate-limit spend and the last-used stamp stand whatever the
	// call does next; a limiter that does not record cannot limit.
	const auth = await ctx.runMutation(internal.mcp.clients.authenticate, {
		tokenHash: await hashApiKey(token),
		ip: getClientIp(request),
	});
	if (!auth.ok) {
		if (auth.reason === 'invalid') return unauthorized('Invalid or revoked token.');
		return json(rpcError(null, RPC_INVALID_REQUEST, 'Rate limit exceeded.'), 429, {
			'Retry-After': String(Math.ceil(auth.retryAfter / 1000)),
		});
	}

	const text = await request.text();
	if (text.length > MAX_BODY_BYTES) {
		return json(rpcError(null, RPC_INVALID_REQUEST, 'Request body too large.'), 413);
	}
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return json(rpcError(null, RPC_PARSE_ERROR, 'Body is not valid JSON.'), 400);
	}
	const message = classifyRpcMessage(body);
	if (message.kind === 'notification' || message.kind === 'response') {
		return new Response(null, { status: 202 });
	}
	if (message.kind === 'invalid') {
		return json(rpcError(message.id, message.code, message.message), 400);
	}

	switch (message.method) {
		case 'initialize':
			return json(
				rpcResult(message.id, initializeResult(message.params['protocolVersion'], auth.access))
			);
		case 'ping':
			return json(rpcResult(message.id, {}));
		case 'tools/list':
			return json(rpcResult(message.id, { tools: toolDefinitionsFor(auth.access) }));
		case 'tools/call': {
			try {
				const outcome = await callTool(ctx, auth.clientId, auth.access, message.params);
				return outcome.ok
					? json(rpcResult(message.id, outcome.result))
					: json(rpcError(message.id, outcome.code, outcome.message));
			} catch (error) {
				logError('[MCP] call failed', { clientId: auth.clientId, error: String(error) });
				return json(rpcError(message.id, RPC_INTERNAL_ERROR, 'Internal error.'), 500);
			}
		}
		default:
			return json(rpcError(message.id, RPC_METHOD_NOT_FOUND, `Unknown method: ${message.method}`));
	}
});

/** GET (a server-sent event stream) and DELETE (a session end) do not apply to a stateless server. */
export const postboxMcpMethodNotAllowed = httpAction(
	async () => new Response(null, { status: 405, headers: { Allow: 'POST' } })
);
