/**
 * Writes an MCP client asks for, and the owner's approval of them.
 *
 * A write tool never changes mail on the client's word. `propose` checks the
 * request against the client's reach, as the read tools do, and records a
 * pending action; the token's owner then approves or rejects it in Owlat.
 * Approval checks the reach again, because membership, a team inbox or the
 * token may have gone in between, and only then runs the same Postbox
 * mutation the web app uses (`mcp/actionRun.ts`), under the owner's session,
 * so every mailbox and team-inbox permission applies as if they had clicked
 * it themselves.
 *
 * The owner approves what the card showed them, not an id. The card carries a
 * digest of everything the run will act on (for a send: recipients, subject,
 * the whole body, attachments and From identity), and `approve` recomputes it
 * in its own transaction: a draft another session or a teammate changed after
 * the card loaded is refused, never sent.
 *
 * A pending action lapses after {@link PENDING_ACTION_TTL_MS}, goes with its
 * token when that is revoked, and every step is written to the client's
 * activity log.
 */

import { ConvexError, v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { throwNotFound } from '../_utils/errors';
import type { McpAction, McpActionStatus, McpActivityOutcome } from '../lib/validators/mcp';
import { enqueuePush } from '../push/events';
import { resolveMcpAccess } from './access';
import { appendActivity } from './activity';
import { mcpMutation, mcpQuery } from './_helpers';
import type { ToolOutcome } from './reads';
import { checkRequest, writeRequestValidator } from './actionRequests';
import { canReach, review } from './actionReview';

/** How long an action waits for the owner before it lapses. */
export const PENDING_ACTION_TTL_MS = 24 * 60 * 60 * 1000;
/** Actions one client may have waiting at once; past it, new writes are refused. */
export const PENDING_PER_CLIENT_MAX = 20;
/** Decided actions stay readable by `get_action_status` this long, then the sweep deletes them. */
export const DECIDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Rows one sweep pass touches; a full batch schedules the next pass. */
const SWEEP_BATCH = 100;
const FAILURE_MESSAGE_MAX = 300;

const NO_ACCESS = 'This connection no longer has access. Ask its owner to check it in Owlat.';
const READ_ONLY =
	'This connection is read-only. Its owner can connect a read-write client in Owlat.';
const LOST_ACCESS = 'The connection no longer has access to this mailbox.';
const CHANGED = 'This changed after you opened it. Check it again, then approve.';

function threadOf(action: McpAction): Id<'mailThreads'> | undefined {
	return 'threadId' in action ? action.threadId : undefined;
}

/** Check a write and record it as pending; what to answer the client. */
async function proposeWrite(
	ctx: MutationCtx,
	args: { clientId: Id<'mcpClients'>; request: typeof writeRequestValidator.type }
): Promise<ToolOutcome> {
	const access = await resolveMcpAccess(ctx, args.clientId);
	if (!access.ok) return { status: 'denied', message: NO_ACCESS, audit: {} };
	const { client } = access;
	if (client.access !== 'read_write') return { status: 'denied', message: READ_ONLY, audit: {} };
	const checked = await checkRequest(
		ctx,
		new Set(access.mailboxes.map((mailbox) => mailbox._id)),
		args.request
	);
	if (!checked.ok) return { status: checked.status, message: checked.message, audit: {} };
	const audit = {
		mailboxId: checked.mailboxId,
		...(checked.threadId ? { threadId: checked.threadId } : {}),
	};

	const waiting = await ctx.db
		.query('mcpPendingActions')
		.withIndex('by_client_and_status', (q) => q.eq('clientId', client._id).eq('status', 'pending'))
		.take(PENDING_PER_CLIENT_MAX);
	if (waiting.length >= PENDING_PER_CLIENT_MAX) {
		return {
			status: 'invalid',
			message: `${PENDING_PER_CLIENT_MAX} actions are already waiting for approval. Wait until the owner decides on them.`,
			audit,
		};
	}

	const now = Date.now();
	const expiresAt = now + PENDING_ACTION_TTL_MS;
	const actionId = await ctx.db.insert('mcpPendingActions', {
		organizationId: client.organizationId,
		clientId: client._id,
		userId: client.userId,
		mailboxId: checked.mailboxId,
		action: checked.action,
		status: 'pending',
		createdAt: now,
		expiresAt,
	});
	await enqueuePush(ctx, client.userId, { kind: 'mcpAction', actionId });
	return {
		status: 'ok',
		logAs: 'pending_approval',
		isAction: true,
		payload: {
			action_id: actionId,
			status: 'pending',
			expires_at: new Date(expiresAt).toISOString(),
			message:
				'Waiting for the mailbox owner to approve this in Owlat. Call get_action_status with this action_id to learn how it ended.',
		},
		audit,
	};
}

/**
 * Record a write the client asked for, after checking it, and log the step in
 * the same transaction, so the HTTP action commits once. Called by
 * `mcp/serverHttp.ts` for every write tool.
 */
export const propose = internalMutation({
	args: { clientId: v.id('mcpClients'), request: writeRequestValidator },
	handler: async (ctx, args): Promise<ToolOutcome> => {
		const outcome = await proposeWrite(ctx, args);
		const client = await ctx.db.get(args.clientId);
		if (client) {
			await appendActivity(ctx, client, {
				tool: args.request.tool,
				outcome: outcome.status === 'ok' ? (outcome.logAs ?? 'ok') : outcome.status,
				...outcome.audit,
			});
		}
		return outcome;
	},
});

/** `get_action_status`: one of this client's own actions, never another client's. */
export const getStatus = internalQuery({
	args: { clientId: v.id('mcpClients'), actionId: v.string() },
	handler: async (ctx, args): Promise<ToolOutcome> => {
		const access = await resolveMcpAccess(ctx, args.clientId);
		if (!access.ok) return { status: 'denied', message: NO_ACCESS, audit: {} };
		const actionId = ctx.db.normalizeId('mcpPendingActions', args.actionId);
		const row = actionId ? await ctx.db.get(actionId) : null;
		if (!row || row.clientId !== args.clientId) {
			return {
				status: 'denied',
				message: 'No action with that id belongs to this connection.',
				audit: {},
			};
		}
		return {
			status: 'ok',
			isAction: true,
			payload: {
				action_id: row._id,
				tool: row.action.tool,
				status: row.status,
				created_at: new Date(row.createdAt).toISOString(),
				expires_at: new Date(row.expiresAt).toISOString(),
				...(row.decidedAt !== undefined
					? { decided_at: new Date(row.decidedAt).toISOString() }
					: {}),
				...(row.resultDraftId ? { draft_id: row.resultDraftId } : {}),
				...(row.failureMessage ? { error: row.failureMessage } : {}),
			},
			audit: { mailboxId: row.mailboxId },
		};
	},
});

/** Move a pending action to its final status and log the step. */
async function settle(
	ctx: MutationCtx,
	row: Doc<'mcpPendingActions'>,
	status: Exclude<McpActionStatus, 'pending'>,
	outcome: McpActivityOutcome,
	extra: { resultDraftId?: Id<'mailDrafts'>; failureMessage?: string } = {}
): Promise<void> {
	await ctx.db.patch(row._id, { status, decidedAt: Date.now(), ...extra });
	const client = await ctx.db.get(row.clientId);
	if (!client) return;
	const threadId = threadOf(row.action);
	await appendActivity(ctx, client, {
		tool: row.action.tool,
		outcome,
		mailboxId: row.mailboxId,
		...(threadId ? { threadId } : {}),
	});
}

/** The caller's own action, or a not-found that does not say whether the id exists. */
async function loadOwnAction(
	ctx: QueryCtx,
	actionId: Id<'mcpPendingActions'>,
	session: { userId: string; activeOrganizationId: string }
): Promise<Doc<'mcpPendingActions'>> {
	const row = await ctx.db.get(actionId);
	if (
		!row ||
		row.userId !== session.userId ||
		row.organizationId !== session.activeOrganizationId
	) {
		throwNotFound('Action');
	}
	return row;
}

function failureText(error: unknown): string {
	const data = error instanceof ConvexError ? (error.data as { message?: unknown }) : null;
	const message =
		data && typeof data.message === 'string'
			? data.message
			: 'The action could not run. Try it again in Owlat.';
	return message.slice(0, FAILURE_MESSAGE_MAX);
}

// authz: self-scope — only the client's owner decides (row.userId === session.userId);
// the run then goes through the Postbox mutations' own mailbox gates under that session.
export const approve = mcpMutation({
	args: { actionId: v.id('mcpPendingActions'), reviewDigest: v.string() },
	handler: async (
		ctx,
		args,
		session
	): Promise<{ status: McpActionStatus; failureMessage?: string; isChanged?: true }> => {
		const row = await loadOwnAction(ctx, args.actionId, session);
		if (row.status !== 'pending') return { status: row.status };
		if (row.expiresAt <= Date.now()) {
			await settle(ctx, row, 'expired', 'expired');
			return { status: 'expired' };
		}
		if (!(await canReach(ctx, row))) {
			await settle(ctx, row, 'failed', 'denied', { failureMessage: LOST_ACCESS });
			return { status: 'failed', failureMessage: LOST_ACCESS };
		}
		// Same transaction as the run below, so nothing can change in between.
		const { reviewDigest } = await review(ctx, row, true);
		if (reviewDigest !== null && reviewDigest !== args.reviewDigest) {
			return { status: 'pending', isChanged: true, failureMessage: CHANGED };
		}
		try {
			// Its own transaction: a failed run leaves nothing half done.
			const result: { draftId?: Id<'mailDrafts'> } = await ctx.runMutation(
				internal.mcp.actionRun.run,
				{ actionId: row._id }
			);
			await settle(
				ctx,
				row,
				'approved',
				'approved',
				result.draftId ? { resultDraftId: result.draftId } : {}
			);
			return { status: 'approved' };
		} catch (error) {
			const failureMessage = failureText(error);
			await settle(ctx, row, 'failed', 'error', { failureMessage });
			return { status: 'failed', failureMessage };
		}
	},
});

// authz: self-scope — only the client's owner decides (row.userId === session.userId).
export const reject = mcpMutation({
	args: { actionId: v.id('mcpPendingActions') },
	handler: async (ctx, args, session): Promise<{ status: McpActionStatus }> => {
		const row = await loadOwnAction(ctx, args.actionId, session);
		if (row.status !== 'pending') return { status: row.status };
		await settle(ctx, row, 'rejected', 'rejected');
		return { status: 'rejected' };
	},
});

/** Cancel every action still waiting on a client; its token was revoked. */
export async function cancelPendingForClient(
	ctx: MutationCtx,
	clientId: Id<'mcpClients'>
): Promise<void> {
	// bounded: `propose` keeps at most PENDING_PER_CLIENT_MAX waiting per client.
	const waiting = await ctx.db
		.query('mcpPendingActions')
		.withIndex('by_client_and_status', (q) => q.eq('clientId', clientId).eq('status', 'pending'))
		.take(PENDING_PER_CLIENT_MAX);
	for (const row of waiting) await settle(ctx, row, 'cancelled', 'cancelled');
}

// authz: self-scope — the caller's own pending actions, read by their userId; what
// each describes is shown only while its client can still reach the mailbox.
export const listPending = mcpQuery({
	args: {},
	handler: async (ctx, _args, session) => {
		const rows = await ctx.db
			.query('mcpPendingActions')
			.withIndex('by_user_org_and_status', (q) =>
				q
					.eq('userId', session.userId)
					.eq('organizationId', session.activeOrganizationId)
					.eq('status', 'pending')
			)
			.order('desc')
			.take(50);
		const reach = new Map<Id<'mcpClients'>, Set<Id<'mailboxes'>>>();
		const result = [];
		for (const row of rows) {
			const client = await ctx.db.get(row.clientId);
			const isReachable = await canReach(ctx, row, reach);
			const mailbox = isReachable ? await ctx.db.get(row.mailboxId) : null;
			const { details, reviewDigest } = await review(ctx, row, isReachable);
			result.push({
				_id: row._id,
				tool: row.action.tool,
				clientLabel: client?.label ?? '',
				mailboxAddress: mailbox?.address ?? null,
				createdAt: row.createdAt,
				expiresAt: row.expiresAt,
				details,
				reviewDigest,
			});
		}
		return result;
	},
});

/**
 * Lapse the actions nobody decided on in time, and delete decided ones past
 * their retention. Patching a row out of `pending`, or deleting it, takes it
 * out of the index range read here, so each pass starts from the front.
 */
export const sweep = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const lapsed = await ctx.db
			.query('mcpPendingActions')
			.withIndex('by_status_and_expires', (q) => q.eq('status', 'pending').lte('expiresAt', now))
			.take(SWEEP_BATCH);
		for (const row of lapsed) await settle(ctx, row, 'expired', 'expired');
		const stale = await ctx.db
			.query('mcpPendingActions')
			.withIndex('by_decided_at', (q) =>
				q.gte('decidedAt', 0).lt('decidedAt', now - DECIDED_RETENTION_MS)
			)
			.take(SWEEP_BATCH);
		for (const row of stale) await ctx.db.delete(row._id);
		if (lapsed.length === SWEEP_BATCH || stale.length === SWEEP_BATCH) {
			await ctx.scheduler.runAfter(0, internal.mcp.actions.sweep, {});
		}
	},
});
