/**
 * Reading the company index for one viewer.
 *
 * A viewer sees the conversations they could open anyway: their own and
 * shared mailboxes (`loadAccessibleMailboxes`) and, for owners and admins, the
 * Team Inbox. A colleague's personal mail adds exactly one thing: that this
 * colleague is in touch with the company. No subject, no address, no count,
 * no date from that mailbox reaches anyone else.
 */

import { companyNameFromKey } from '@owlat/shared/companyKey';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { isSharedInboxReader } from '../inbox/access';
import { isFeatureEnabled } from '../lib/featureFlags';
import type { OrganizationRole } from '../lib/sessionOrganization';
import { loadAccessibleMailboxes } from '../mail/permissions';

/** Index rows one company read looks at, newest first. */
export const COMPANY_ROW_LIMIT = 300;

export interface CompanyViewer {
	userId: string;
	mailboxes: Map<string, Doc<'mailboxes'>>;
	teamReader: boolean;
}

export async function loadCompanyViewer(
	ctx: QueryCtx,
	session: { userId: string; role: OrganizationRole | null; activeOrganizationId: string }
): Promise<CompanyViewer> {
	const [mailboxes, inboxOn] = await Promise.all([
		loadAccessibleMailboxes(ctx, session.userId, session.activeOrganizationId),
		isFeatureEnabled(ctx, 'inbox'),
	]);
	return {
		userId: session.userId,
		mailboxes: new Map(mailboxes.map((m) => [m._id as string, m])),
		// The Team Inbox is for shared-inbox readers, while the inbox feature is on.
		teamReader: isSharedInboxReader(session) && inboxOn,
	};
}

export function canOpenRow(viewer: CompanyViewer, row: Doc<'companyThreads'>): boolean {
	if (row.kind === 'team') return viewer.teamReader;
	return row.mailboxId !== undefined && viewer.mailboxes.has(row.mailboxId);
}

/**
 * The colleague a row that the viewer cannot open stands for, or null. Only a
 * personal mailbox has one; a shared mailbox the viewer is not in, or the Team
 * Inbox for a non-admin, says nothing about anyone.
 */
export function colleagueOf(viewer: CompanyViewer, row: Doc<'companyThreads'>): string | null {
	if (canOpenRow(viewer, row)) return null;
	if (!row.ownerUserId || row.ownerUserId === viewer.userId) return null;
	return row.ownerUserId;
}

export interface CompanyConversation {
	kind: 'mail' | 'team';
	mailThreadId: Id<'mailThreads'> | null;
	/** The thread's newest message: the Postbox reader opens a conversation by message. */
	messageId: Id<'mailMessages'> | null;
	conversationThreadId: Id<'conversationThreads'> | null;
	mailboxId: Id<'mailboxes'> | null;
	mailboxName: string | null;
	subject: string;
	snippet: string | null;
	addresses: string[];
	lastMessageAt: number;
}

export interface CompanyPerson {
	address: string;
	name: string | null;
	conversations: number;
	lastMessageAt: number;
}

export interface CompanyView {
	key: string;
	name: string;
	people: CompanyPerson[];
	conversations: CompanyConversation[];
	/** Colleagues in touch with the company through mail the viewer cannot open. */
	colleagueUserIds: string[];
	lastMessageAt: number | null;
}

async function conversationOf(
	ctx: QueryCtx,
	viewer: CompanyViewer,
	row: Doc<'companyThreads'>
): Promise<CompanyConversation | null> {
	if (row.kind === 'team' && row.conversationThreadId) {
		const thread = await ctx.db.get(row.conversationThreadId);
		if (!thread) return null;
		return {
			kind: 'team',
			mailThreadId: null,
			messageId: null,
			conversationThreadId: thread._id,
			mailboxId: null,
			mailboxName: null,
			subject: thread.subject,
			snippet: null,
			addresses: row.addresses,
			lastMessageAt: thread.lastMessageAt,
		};
	}
	if (row.kind === 'mail' && row.mailThreadId && row.mailboxId) {
		const thread = await ctx.db.get(row.mailThreadId);
		if (!thread) return null;
		const mailbox = viewer.mailboxes.get(row.mailboxId);
		return {
			kind: 'mail',
			mailThreadId: thread._id,
			messageId: thread.latestMessageId ?? null,
			conversationThreadId: null,
			mailboxId: row.mailboxId,
			mailboxName: mailbox ? (mailbox.displayName ?? mailbox.address) : null,
			subject: thread.latestSubject,
			snippet: thread.latestSnippet || null,
			addresses: row.addresses,
			lastMessageAt: thread.lastMessageAt,
		};
	}
	return null;
}

/** A display name for an address from the CRM, when someone recorded one. */
async function contactName(ctx: QueryCtx, address: string): Promise<string | null> {
	// token-safe: projects the contact to its first and last name.
	const contact = await ctx.db
		.query('contacts')
		.withIndex('by_email_and_deleted_at', (q) => q.eq('email', address).eq('deletedAt', undefined))
		.first();
	if (!contact) return null;
	const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
	return name || null;
}

export interface CompanyLimits {
	conversations: number;
	people: number;
	/** A conversation to leave out, such as the one the panel sits beside. */
	exclude?: { mailThreadId?: Id<'mailThreads'>; conversationThreadId?: Id<'conversationThreads'> };
}

export async function loadCompany(
	ctx: QueryCtx,
	viewer: CompanyViewer,
	key: string,
	limits: CompanyLimits
): Promise<CompanyView> {
	const rows = await ctx.db
		.query('companyThreads')
		.withIndex('by_company_last', (q) => q.eq('companyKey', key))
		.order('desc')
		.take(COMPANY_ROW_LIMIT);
	const colleagues = new Set<string>();
	const people = new Map<string, CompanyPerson>();
	const conversations: CompanyConversation[] = [];
	let lastMessageAt: number | null = null;
	for (const row of rows) {
		const colleague = colleagueOf(viewer, row);
		if (colleague) colleagues.add(colleague);
		if (!canOpenRow(viewer, row)) continue;
		lastMessageAt = Math.max(lastMessageAt ?? 0, row.lastMessageAt);
		for (const address of row.addresses) {
			const person = people.get(address) ?? {
				address,
				name: null,
				conversations: 0,
				lastMessageAt: row.lastMessageAt,
			};
			person.conversations += 1;
			person.lastMessageAt = Math.max(person.lastMessageAt, row.lastMessageAt);
			people.set(address, person);
		}
		const excluded =
			(limits.exclude?.mailThreadId && row.mailThreadId === limits.exclude.mailThreadId) ||
			(limits.exclude?.conversationThreadId &&
				row.conversationThreadId === limits.exclude.conversationThreadId);
		if (excluded || conversations.length >= limits.conversations) continue;
		const conversation = await conversationOf(ctx, viewer, row);
		if (conversation) conversations.push(conversation);
	}
	const topPeople = [...people.values()]
		.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
		.slice(0, limits.people);
	for (const person of topPeople) person.name = await contactName(ctx, person.address);
	return {
		key,
		name: companyNameFromKey(key),
		people: topPeople,
		conversations,
		colleagueUserIds: [...colleagues],
		lastMessageAt,
	};
}
