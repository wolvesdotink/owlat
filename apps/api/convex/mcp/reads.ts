/**
 * The read tools behind the Postbox MCP server, one internal query per tool.
 *
 * Each one resolves the client's reach through `resolveMcpAccess` first and
 * reads only inside it; ids arrive as plain strings from the wire and are
 * normalized here, so a malformed or foreign id is a refusal, not a throw. No
 * tool writes: reading a thread does not mark it read.
 *
 * Mail text leaves through `scrubForInjection`, the filter the in-app assistant
 * applies to retrieved content, and `mcp/protocol.ts` fences the whole result
 * as untrusted data.
 */

import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { htmlToPlainText } from '@owlat/shared/html';
import { parseSearchQuery } from '@owlat/shared/mailSearch';
import { scrubForInjection } from '../assistant/prompt';
import { openStoredInlineBody } from '../lib/messageBodyStore';
import { normalizeClause } from '../mail/mailbox/searchClause';
import { searchMailbox, searchMailboxes } from '../mail/mailbox/search';
import { resolveMcpAccess } from './access';
import type { McpActivityOutcome } from '../lib/validators/mcp';

/** Longest body one message returns; the rest is cut and flagged. */
const BODY_MAX_CHARS = 20_000;

type Audit = { mailboxId?: Id<'mailboxes'>; threadId?: Id<'mailThreads'>; resultCount?: number };

export type ToolOutcome =
	| {
			status: 'ok';
			payload: Record<string, unknown>;
			audit: Audit;
			// A write's answer is logged as the step it reached, not as `ok`.
			logAs?: McpActivityOutcome;
			// Owlat's own words about an action, not mail: sent without the untrusted fence.
			isAction?: true;
	  }
	| { status: 'denied' | 'invalid'; message: string; audit: Audit };

const NO_ACCESS = 'This connection no longer has access. Ask its owner to check it in Owlat.';
const UNKNOWN_MAILBOX = 'No mailbox with that id is available to this connection.';

function denied(message: string, audit: Audit = {}): ToolOutcome {
	return { status: 'denied', message, audit };
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function scrubbed(text: string | undefined): string {
	return text ? scrubForInjection(text) : '';
}

function person(address: string, name: string | undefined) {
	return name ? { name: scrubForInjection(name), address } : { address };
}

/** The client's mailbox with this wire id, or null when it is not one of them. */
async function pickMailbox(
	ctx: QueryCtx,
	clientId: Id<'mcpClients'>,
	rawMailboxId: string
): Promise<{ ok: true; mailbox: Doc<'mailboxes'> } | { ok: false; outcome: ToolOutcome }> {
	const access = await resolveMcpAccess(ctx, clientId);
	if (!access.ok) return { ok: false, outcome: denied(NO_ACCESS) };
	const mailboxId = ctx.db.normalizeId('mailboxes', rawMailboxId);
	const mailbox = mailboxId ? access.mailboxes.find((m) => m._id === mailboxId) : undefined;
	if (!mailbox) return { ok: false, outcome: denied(UNKNOWN_MAILBOX) };
	return { ok: true, mailbox };
}

export const listMailboxes = internalQuery({
	args: { clientId: v.id('mcpClients') },
	handler: async (ctx, args): Promise<ToolOutcome> => {
		const access = await resolveMcpAccess(ctx, args.clientId);
		if (!access.ok) return denied(NO_ACCESS);
		const mailboxes = access.mailboxes.map((mailbox) => ({
			mailbox_id: mailbox._id,
			address: mailbox.address,
			name: mailbox.displayName?.trim() || mailbox.address,
			kind: mailbox.scope === 'shared' ? 'team_inbox' : 'personal',
		}));
		return { status: 'ok', payload: { mailboxes }, audit: { resultCount: mailboxes.length } };
	},
});

export const listFolders = internalQuery({
	args: { clientId: v.id('mcpClients'), mailboxId: v.string() },
	handler: async (ctx, args): Promise<ToolOutcome> => {
		const picked = await pickMailbox(ctx, args.clientId, args.mailboxId);
		if (!picked.ok) return picked.outcome;
		const rows = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', picked.mailbox._id))
			.collect(); // bounded: one mailbox's folders
		const folders = rows.map((folder) => ({
			folder_id: folder._id,
			name: scrubForInjection(folder.name),
			...(folder.role ? { role: folder.role } : {}),
			total: folder.totalCount,
			unread: folder.unseenCount,
		}));
		return {
			status: 'ok',
			payload: { mailbox_id: picked.mailbox._id, folders },
			audit: { mailboxId: picked.mailbox._id, resultCount: folders.length },
		};
	},
});

export const listLabels = internalQuery({
	args: { clientId: v.id('mcpClients'), mailboxId: v.string() },
	handler: async (ctx, args): Promise<ToolOutcome> => {
		const picked = await pickMailbox(ctx, args.clientId, args.mailboxId);
		if (!picked.ok) return picked.outcome;
		const rows = await ctx.db
			.query('mailLabels')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', picked.mailbox._id))
			.collect(); // bounded: one mailbox's labels
		const labels = rows.map((label) => ({
			label_id: label._id,
			name: scrubForInjection(label.name),
			...(label.parentId ? { parent_id: label.parentId } : {}),
		}));
		return {
			status: 'ok',
			payload: { mailbox_id: picked.mailbox._id, labels },
			audit: { mailboxId: picked.mailbox._id, resultCount: labels.length },
		};
	},
});

function searchHit(message: Doc<'mailMessages'>) {
	return {
		message_id: message._id,
		thread_id: message.threadId,
		mailbox_id: message.mailboxId,
		from: person(message.fromAddress, message.fromName),
		to: message.toAddresses,
		subject: scrubbed(message.subject),
		snippet: scrubbed(message.snippet),
		received_at: iso(message.receivedAt),
		unread: !message.flagSeen,
		flagged: message.flagFlagged,
		has_attachments: message.attachments.length > 0,
	};
}

export const searchMail = internalQuery({
	args: {
		clientId: v.id('mcpClients'),
		query: v.string(),
		mailboxId: v.optional(v.string()),
		limit: v.number(),
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<ToolOutcome> => {
		const access = await resolveMcpAccess(ctx, args.clientId);
		if (!access.ok) return denied(NO_ACCESS);
		let targets = access.mailboxes.map((mailbox) => mailbox._id);
		if (args.mailboxId !== undefined) {
			const wanted = ctx.db.normalizeId('mailboxes', args.mailboxId);
			targets = targets.filter((id) => id === wanted);
			if (targets.length === 0) return denied(UNKNOWN_MAILBOX);
		}
		const { or, ...primary } = parseSearchQuery(args.query);
		const clauses = [primary, ...(or ?? [])].map(normalizeClause);
		// One mailbox pages natively, so free text reaches every match. Across
		// several, free text gives one page per mailbox, as in the web app.
		const page =
			targets.length === 1
				? await searchMailbox(ctx, targets[0]!, clauses, args.limit, args.cursor)
				: await searchMailboxes(ctx, targets, clauses, args.limit, args.cursor);
		const results = page.messages.map(searchHit);
		return {
			status: 'ok',
			payload: { results, next_cursor: page.nextCursor },
			audit: {
				...(targets.length === 1 ? { mailboxId: targets[0] } : {}),
				resultCount: results.length,
			},
		};
	},
});

async function threadMessage(ctx: QueryCtx, message: Doc<'mailMessages'>) {
	const inline = await openStoredInlineBody(ctx.db, message);
	const plain =
		inline.text || (inline.html ? htmlToPlainText(inline.html, { preserveBreaks: true }) : '');
	// Bodies over the inline threshold live in storage blobs, which a query
	// cannot read; the snippet stands in and the flag says so.
	const isStoredElsewhere = !plain && message.snippet !== '';
	const isTruncated = plain.length > BODY_MAX_CHARS;
	return {
		message_id: message._id,
		from: person(message.fromAddress, message.fromName),
		to: message.toAddresses,
		cc: message.ccAddresses,
		date: iso(message.receivedAt),
		subject: scrubbed(message.subject),
		body: scrubbed(isStoredElsewhere ? message.snippet : plain.slice(0, BODY_MAX_CHARS)),
		...(isTruncated ? { body_truncated: true } : {}),
		...(isStoredElsewhere ? { body_is_snippet_only: true } : {}),
		...(message.flagDraft ? { draft: true } : {}),
		attachments: message.attachments.map((attachment) => ({
			filename: scrubForInjection(attachment.filename),
			size: attachment.size,
		})),
	};
}

export const readThread = internalQuery({
	args: { clientId: v.id('mcpClients'), messageId: v.string(), maxMessages: v.number() },
	handler: async (ctx, args): Promise<ToolOutcome> => {
		const access = await resolveMcpAccess(ctx, args.clientId);
		if (!access.ok) return denied(NO_ACCESS);
		const seedId = ctx.db.normalizeId('mailMessages', args.messageId);
		const seed = seedId ? await ctx.db.get(seedId) : null;
		// A message outside the client's mailboxes reads exactly like a missing
		// one, so the answer does not confirm that an id exists elsewhere.
		if (!seed || !access.mailboxes.some((mailbox) => mailbox._id === seed.mailboxId)) {
			return denied('No message with that id is available to this connection.');
		}
		const newest = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread_and_received', (q) => q.eq('threadId', seed.threadId))
			.order('desc')
			.take(args.maxMessages + 1);
		const hasOlder = newest.length > args.maxMessages;
		const inMailbox = newest
			.slice(0, args.maxMessages)
			.filter((message) => message.mailboxId === seed.mailboxId)
			.reverse();
		const messages = [];
		for (const message of inMailbox) messages.push(await threadMessage(ctx, message));
		return {
			status: 'ok',
			payload: {
				thread_id: seed.threadId,
				mailbox_id: seed.mailboxId,
				messages,
				has_older_messages: hasOlder,
			},
			audit: { mailboxId: seed.mailboxId, threadId: seed.threadId, resultCount: messages.length },
		};
	},
});
