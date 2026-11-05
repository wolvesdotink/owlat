/**
 * Companies: the people a workspace talks to, grouped by the organisational
 * domain of their addresses. See companies/read.ts for what a viewer sees.
 */

import { v } from 'convex/values';
import { companyKeyOfDomain, companyNameFromKey } from '@owlat/shared/companyKey';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { isSharedInboxReader } from '../inbox/access';
import { authedQuery } from '../lib/authedFunctions';
import { groupByCompany, teamThreadCompanies } from './eligibility';
import { loadOwnDomains } from './ownDomains';
import { canOpenRow, loadCompany, loadCompanyViewer, type CompanyView } from './read';

/** Index rows per mailbox (and for the Team Inbox) the company list reads. */
const LIST_ROWS_PER_SOURCE = 300;
const LIST_LIMIT = 200;

export interface CompanySummary {
	key: string;
	name: string;
	conversations: number;
	people: string[];
	peopleCount: number;
	lastMessageAt: number;
}

/** The companies in the viewer's conversations, most recent contact first. */
// authz: reads only rows of loadAccessibleMailboxes and, for shared-inbox readers, the Team Inbox.
export const list = authedQuery({
	args: {},
	handler: async (ctx, _args, session): Promise<CompanySummary[]> => {
		const viewer = await loadCompanyViewer(ctx, session);
		const sources = [...viewer.mailboxes.keys()].map((mailboxId) =>
			ctx.db
				.query('companyThreads')
				.withIndex('by_mailbox_last', (q) =>
					q.eq('mailboxId', mailboxId as Doc<'mailboxes'>['_id'])
				)
				.order('desc')
				.take(LIST_ROWS_PER_SOURCE)
		);
		if (viewer.teamReader) {
			sources.push(
				ctx.db
					.query('companyThreads')
					.withIndex('by_kind_last', (q) => q.eq('kind', 'team'))
					.order('desc')
					.take(LIST_ROWS_PER_SOURCE)
			);
		}
		const byKey = new Map<string, { conversations: number; people: Set<string>; last: number }>();
		for (const row of (await Promise.all(sources)).flat()) {
			if (!canOpenRow(viewer, row)) continue;
			const entry = byKey.get(row.companyKey) ?? { conversations: 0, people: new Set(), last: 0 };
			entry.conversations += 1;
			for (const address of row.addresses) entry.people.add(address);
			entry.last = Math.max(entry.last, row.lastMessageAt);
			byKey.set(row.companyKey, entry);
		}
		return [...byKey.entries()]
			.map(([key, entry]) => ({
				key,
				name: companyNameFromKey(key),
				conversations: entry.conversations,
				people: [...entry.people].slice(0, 4),
				peopleCount: entry.people.size,
				lastMessageAt: entry.last,
			}))
			.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
			.slice(0, LIST_LIMIT);
	},
});

/** One company: its people, the viewer's conversations with it, and which colleagues also talk to it. */
// authz: loadCompany keeps rows the viewer cannot open (canOpenRow) down to the colleague's user id.
export const get = authedQuery({
	args: { key: v.string() },
	handler: async (ctx, args, session): Promise<CompanyView | null> => {
		const key = companyKeyOfDomain(args.key);
		if (key === null) return null;
		const viewer = await loadCompanyViewer(ctx, session);
		return await loadCompany(ctx, viewer, key, { conversations: 100, people: 50 });
	},
});

async function threadCompanyKeys(
	ctx: QueryCtx,
	args: {
		mailThreadId?: Doc<'mailThreads'>['_id'];
		conversationThreadId?: Doc<'conversationThreads'>['_id'];
	}
): Promise<string[]> {
	const own = await loadOwnDomains(ctx);
	if (args.mailThreadId) {
		const thread = await ctx.db.get(args.mailThreadId);
		return thread ? [...groupByCompany(thread.participants, own).keys()] : [];
	}
	if (args.conversationThreadId) {
		const thread = await ctx.db.get(args.conversationThreadId);
		return thread ? [...teamThreadCompanies(thread, own).keys()] : [];
	}
	return [];
}

/**
 * The companies of the conversation a reader has open, for the panel beside
 * it. Keys come from the thread itself, so a conversation that arrived since
 * the last index sweep still has its company; the rest comes from the index.
 * Empty for a conversation the viewer cannot open.
 */
// authz: the thread must be one the viewer can open (accessible mailbox, or the Team Inbox for readers).
export const forThread = authedQuery({
	args: {
		mailThreadId: v.optional(v.id('mailThreads')),
		conversationThreadId: v.optional(v.id('conversationThreads')),
	},
	handler: async (ctx, args, session): Promise<CompanyView[]> => {
		const viewer = await loadCompanyViewer(ctx, session);
		if (args.mailThreadId) {
			const thread = await ctx.db.get(args.mailThreadId);
			if (!thread || !viewer.mailboxes.has(thread.mailboxId)) return [];
		} else if (args.conversationThreadId) {
			// The Team Inbox is for shared-inbox readers (inbox/access.ts) while it is on.
			if (!isSharedInboxReader(session) || !viewer.teamReader) return [];
		} else {
			return [];
		}
		const keys = (await threadCompanyKeys(ctx, args)).slice(0, 3);
		return await Promise.all(
			keys.map((key) =>
				loadCompany(ctx, viewer, key, {
					conversations: 5,
					people: 6,
					exclude: {
						...(args.mailThreadId ? { mailThreadId: args.mailThreadId } : {}),
						...(args.conversationThreadId
							? { conversationThreadId: args.conversationThreadId }
							: {}),
					},
				})
			)
		);
	},
});
