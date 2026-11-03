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
	TOOL_DEFINITIONS,
	classifyRpcMessage,
	initializeResult,
	isAcceptableProtocolHeader,
	parseToolCall,
	rpcError,
	rpcResult,
	toolError,
	toolResult,
	type ToolArgs,
} from './protocol';
import type { ToolOutcome } from './reads';

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

function runTool(ctx: ActionCtx, clientId: Id<'mcpClients'>, call: ToolArgs): Promise<ToolOutcome> {
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
	}
}

/** Run one `tools/call`, log it, and build the JSON-RPC result. */
async function callTool(
	ctx: ActionCtx,
	clientId: Id<'mcpClients'>,
	params: Record<string, unknown>
): Promise<{ ok: true; result: unknown } | { ok: false; code: number; message: string }> {
	const parsed = parseToolCall(params);
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
		...(outcome?.audit ?? {}),
		...(call.tool === 'search_mail' ? { query: call.query } : {}),
	});
	if (!outcome) return { ok: true, result: toolError('The tool failed. Try again later.') };
	return {
		ok: true,
		result: outcome.status === 'ok' ? toolResult(outcome.payload) : toolError(outcome.message),
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
			return json(rpcResult(message.id, initializeResult(message.params['protocolVersion'])));
		case 'ping':
			return json(rpcResult(message.id, {}));
		case 'tools/list':
			return json(rpcResult(message.id, { tools: TOOL_DEFINITIONS }));
		case 'tools/call': {
			try {
				const outcome = await callTool(ctx, auth.clientId, message.params);
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
