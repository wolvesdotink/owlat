/**
 * Interpretation state for one source message (SPEC §4 step 3, `load.ts`).
 *
 * `loadForInterpretation` is the run's one read before the model call:
 *   - the source: which thread it belongs to, its date, subject and direction,
 *     the mode the thread runs in, and its persisted eligibility signals;
 *   - the thread's brief row (the compare-and-set revision, the deletion
 *     epoch the write must still match);
 *   - the participants of the message with their prompt refs (`p1`, …) and
 *     which addresses are "us";
 *   - the open items plus the items closed in the last 30 days, and (brief
 *     mode) the current facts, unsealed for the prompt.
 *
 * PAGING. The prompt carries at most MAX_PROMPT_ITEMS items and
 * MAX_PROMPT_FACTS facts. Open items come first (oldest ask first), then the
 * recently closed ones (newest first). When the set is larger, the page is cut
 * there and `itemsOverflow` / `factsOverflow` say so: the run marks the
 * interpretation `partial` (coverage overflow) instead of pretending the model
 * saw everything. Nothing is capped silently.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { internalQuery } from '../../_generated/server';
import { normalizeEmail } from '@owlat/shared';
import { APP_LOCALES, isAppLocale, type AppLocale } from '@owlat/shared/appLocales';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import {
	interpretationSourceKey,
	interpretationSourceValidator,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { openMessageBody } from '../../lib/messageBody';
import { mailboxOwnAddresses } from '../identities';
import { loadBriefRow, resolveThreadMode } from './briefRow';
import type { InterpretEligibilitySignals } from './eligibility';
import { loadInterpretSource } from './sources';
import {
	CLOSED_ITEM_LOOKBACK_MS,
	MAX_PROMPT_FACTS,
	MAX_PROMPT_ITEMS,
	type InterpretInputFact,
	type InterpretInputItem,
	type InterpretInputParticipant,
} from './schema';
import type { ReduceResult } from './reduceInput';

type ReadCtx = Pick<QueryCtx, 'db'>;

/** Statuses read as "recently closed" for the prompt. */
const CLOSED_STATUSES = ['done', 'declined', 'superseded', 'untracked'] as const;
/** Items per closed status read within the lookback. */
const CLOSED_SCAN = 100;

// ── Items and facts ────────────────────────────────────────────────────────

/** Read a thread's items with the given status, bounded. */
export async function threadItemsWithStatus(
	ctx: ReadCtx,
	ref: ThreadRef,
	status: Doc<'threadItems'>['status'],
	limit: number
): Promise<Doc<'threadItems'>[]> {
	return ref.kind === 'mail'
		? ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_and_status', (q) =>
					q.eq('mailThreadId', ref.id).eq('status', status)
				)
				.take(limit)
		: ctx.db
				.query('threadItems')
				.withIndex('by_conversation_thread_and_status', (q) =>
					q.eq('conversationThreadId', ref.id).eq('status', status)
				)
				.take(limit);
}

/**
 * The prompt page of a thread's items: open items oldest ask first, then
 * items closed within the lookback newest first, cut at `limit`. Pure.
 */
export function selectPromptItems<T extends { status: string; askedAt: number; updatedAt: number }>(
	rows: readonly T[],
	now: number,
	limit = MAX_PROMPT_ITEMS
): { page: T[]; isOverflow: boolean } {
	const open = rows.filter((r) => r.status === 'open').sort((a, b) => a.askedAt - b.askedAt);
	const closed = rows
		.filter((r) => r.status !== 'open' && now - r.updatedAt <= CLOSED_ITEM_LOOKBACK_MS)
		.sort((a, b) => b.updatedAt - a.updatedAt);
	const all = [...open, ...closed];
	return { page: all.slice(0, limit), isOverflow: all.length > limit };
}

/** A thread's items of `status` changed since `since`, newest first, bounded. */
export async function recentlyUpdatedItems(
	ctx: ReadCtx,
	ref: ThreadRef,
	status: Doc<'threadItems'>['status'],
	since: number,
	limit: number
): Promise<Doc<'threadItems'>[]> {
	return ref.kind === 'mail'
		? ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_and_status', (q) =>
					q.eq('mailThreadId', ref.id).eq('status', status).gte('updatedAt', since)
				)
				.order('desc')
				.take(limit)
		: ctx.db
				.query('threadItems')
				.withIndex('by_conversation_thread_and_status', (q) =>
					q.eq('conversationThreadId', ref.id).eq('status', status).gte('updatedAt', since)
				)
				.order('desc')
				.take(limit);
}

/**
 * Items of `statuses` changed within the closed-item lookback, newest first,
 * read by update time (a long history never hides a recently closed or
 * corrected item). `isCut` says a bound was hit.
 */
export async function recentlyClosedItems(
	ctx: ReadCtx,
	ref: ThreadRef,
	statuses: readonly Doc<'threadItems'>['status'][],
	now: number,
	limitPerStatus: number
): Promise<{ rows: Doc<'threadItems'>[]; isCut: boolean }> {
	const since = now - CLOSED_ITEM_LOOKBACK_MS;
	const found = await Promise.all(
		statuses.map((status) => recentlyUpdatedItems(ctx, ref, status, since, limitPerStatus + 1))
	);
	return {
		rows: found
			.flatMap((rows) => rows.slice(0, limitPerStatus))
			.sort((a, b) => b.updatedAt - a.updatedAt),
		isCut: found.some((rows) => rows.length > limitPerStatus),
	};
}

/**
 * The candidate rows {@link selectPromptItems} picks from: the open items, and
 * the items closed within the lookback. `isScanCut` says a bound was hit: the
 * page is then incomplete, never silently short.
 */
export async function loadPromptItemCandidates(
	ctx: ReadCtx,
	ref: ThreadRef,
	now: number
): Promise<{ rows: Doc<'threadItems'>[]; isScanCut: boolean }> {
	const open = await threadItemsWithStatus(ctx, ref, 'open', MAX_PROMPT_ITEMS + 1);
	const closed = await recentlyClosedItems(ctx, ref, CLOSED_STATUSES, now, CLOSED_SCAN);
	return {
		rows: [...open, ...closed.rows],
		isScanCut: open.length > MAX_PROMPT_ITEMS || closed.isCut,
	};
}

/** A participant ref as the prompt shows `responsible`. */
function responsibleLabel(
	responsible: Doc<'threadItems'>['responsible'],
	participants: readonly InterpretInputParticipant[]
): string {
	const email = responsible.email ? normalizeEmail(responsible.email) : undefined;
	const match =
		(email && participants.find((p) => p.email && normalizeEmail(p.email) === email)) ||
		(responsible.isUs ? participants.find((p) => p.isUs) : undefined);
	if (match) return match.ref;
	return responsible.name ?? responsible.email ?? (responsible.isUs ? 'us' : 'unclear');
}

/** One item as the prompt shows it (unsealed). */
export async function toPromptItem(
	item: Doc<'threadItems'>,
	participants: readonly InterpretInputParticipant[]
): Promise<InterpretInputItem> {
	const quote = item.evidence.find((e) => e.quote !== undefined)?.quote;
	return {
		id: item._id,
		revision: item.revision,
		intent: item.intent,
		facets: item.facets,
		status: item.status,
		responsible: responsibleLabel(item.responsible, participants),
		assertion: await openMessageBody(item.assertion),
		evidenceExcerpt: quote ? await openMessageBody(quote) : '',
	};
}

async function toPromptFact(fact: Doc<'threadFacts'>): Promise<InterpretInputFact> {
	const quote = fact.evidence.find((e) => e.quote !== undefined)?.quote;
	return {
		id: fact._id,
		key: fact.factKey,
		assertion: await openMessageBody(fact.assertion),
		evidenceExcerpt: quote ? await openMessageBody(quote) : '',
	};
}

// ── Sources ────────────────────────────────────────────────────────────────

/** What the run needs to know about the source message itself. */
export interface SourceInfo {
	threadRef: ThreadRef;
	sourceAt: number;
	subject: string;
	direction: 'inbound' | 'outbound';
	/** Mailbox of a mail thread (denormalized onto items). */
	mailboxId?: Id<'mailboxes'>;
	/** The user whose locale and time zone apply (mailbox owner), when there is one. */
	ownerUserId?: string;
	/** Team thread assignee: the default item assignee (D4). */
	threadAssigneeUserId?: string;
	threadMessageCount: number;
	participants: InterpretInputParticipant[];
	/** The mailbox's (or inbox's) own addresses, lowercased. */
	ownAddresses: string[];
}

function participantList(
	entries: Array<{ role: InterpretInputParticipant['role']; email?: string; name?: string }>,
	own: ReadonlySet<string>
): InterpretInputParticipant[] {
	const seen = new Set<string>();
	const out: InterpretInputParticipant[] = [];
	for (const entry of entries) {
		const email = entry.email ? normalizeEmail(entry.email) : undefined;
		const key = `${entry.role}:${email ?? entry.name ?? ''}`;
		if (!email && !entry.name) continue;
		if (seen.has(key)) continue;
		seen.add(key);
		const isUs = !!email && own.has(email);
		out.push({
			ref: `p${out.length + 1}`,
			role: isUs && entry.role !== 'from' ? 'us' : entry.role,
			...(entry.name ? { name: entry.name } : {}),
			...(email ? { email } : {}),
			isUs,
		});
	}
	return out;
}

async function mailSourceInfo(
	ctx: QueryCtx,
	message: Doc<'mailMessages'>,
	kind: 'mail' | 'outboundMail'
): Promise<SourceInfo | null> {
	const thread = await ctx.db.get(message.threadId);
	if (!thread) return null;
	const mailbox = await ctx.db.get(thread.mailboxId);
	if (!mailbox) return null;
	const own = await mailboxOwnAddresses(ctx, mailbox);
	const isOutbound =
		kind === 'outboundMail' ||
		message.outbound !== undefined ||
		own.has(normalizeEmail(message.fromAddress));
	return {
		threadRef: { kind: 'mail', id: thread._id },
		sourceAt: message.receivedAt,
		subject: message.subject,
		direction: isOutbound ? 'outbound' : 'inbound',
		mailboxId: mailbox._id,
		ownerUserId: mailbox.userId,
		threadMessageCount: thread.messageCount,
		participants: participantList(
			[
				{ role: 'from', email: message.fromAddress, name: message.fromName },
				...message.toAddresses.map((email) => ({ role: 'to' as const, email })),
				...message.ccAddresses.map((email) => ({ role: 'cc' as const, email })),
			],
			own
		),
		ownAddresses: [...own],
	};
}

async function teamSourceInfo(
	ctx: QueryCtx,
	inbound: Doc<'inboundMessages'>,
	reply?: Doc<'transactionalSends'>
): Promise<SourceInfo | null> {
	if (!inbound.threadId) return null;
	const thread = await ctx.db.get(inbound.threadId);
	if (!thread) return null;
	const own = new Set([normalizeEmail(inbound.to)]);
	const entries = reply
		? [
				{ role: 'from' as const, email: inbound.to },
				{ role: 'to' as const, email: reply.email },
			]
		: [
				{ role: 'from' as const, email: inbound.from },
				{ role: 'to' as const, email: inbound.to },
			];
	return {
		threadRef: { kind: 'team', id: thread._id },
		sourceAt: reply ? (reply.queuedAt ?? reply._creationTime) : inbound.receivedAt,
		subject: reply?.subject ?? inbound.subject,
		direction: reply ? 'outbound' : 'inbound',
		...(thread.assignedTo ? { threadAssigneeUserId: thread.assignedTo } : {}),
		threadMessageCount: thread.messageCount,
		participants: participantList(entries, own),
		ownAddresses: [...own],
	};
}

/** Where a source lives and who is on it; null when it (or its thread) is gone. */
export async function loadSourceInfo(
	ctx: QueryCtx,
	source: InterpretationSource
): Promise<SourceInfo | null> {
	switch (source.kind) {
		case 'mail':
		case 'outboundMail': {
			const message = await ctx.db.get(source.id);
			return message ? mailSourceInfo(ctx, message, source.kind) : null;
		}
		case 'inbound': {
			const inbound = await ctx.db.get(source.id);
			return inbound ? teamSourceInfo(ctx, inbound) : null;
		}
		case 'teamReply': {
			const reply = await ctx.db.get(source.id);
			const inbound = reply?.inboundMessageId ? await ctx.db.get(reply.inboundMessageId) : null;
			return reply && inbound ? teamSourceInfo(ctx, inbound, reply) : null;
		}
	}
}

/** The interface locales display text is written in (every locale the app ships). */
export const INTERPRET_LOCALES: readonly AppLocale[] = APP_LOCALES;

/** The owner's interface locale (userProfiles.locale), English when unset. */
export async function ownerLocale(ctx: ReadCtx, userId: string | undefined): Promise<AppLocale> {
	if (!userId) return 'en';
	const profile = await ctx.db
		.query('userProfiles')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', userId))
		.first();
	return profile?.locale && isAppLocale(profile.locale) ? profile.locale : 'en';
}

/** The time zone deadlines resolve in: the owner's booking profile, the instance, else UTC. */
export async function ownerTimeZone(ctx: ReadCtx, userId: string | undefined): Promise<string> {
	if (userId) {
		const profile = await ctx.db
			.query('bookingProfiles')
			.withIndex('by_user', (q) => q.eq('userId', userId))
			.first();
		if (profile?.timeZone) return profile.timeZone;
	}
	const settings = await ctx.db.query('instanceSettings').first();
	return settings?.timezone ?? 'UTC';
}

/** The stored result of an extraction, or null when it has none or it does not parse. */
export async function readResult(row: Doc<'messageInterpretations'>): Promise<ReduceResult | null> {
	if (!row.payload) return null;
	try {
		return JSON.parse(await openMessageBody(row.payload)) as ReduceResult;
	} catch {
		return null;
	}
}

/** The stored result of one extraction (a replayed run hands it to its caller). */
export const readStoredResult = internalQuery({
	args: { interpretationId: v.id('messageInterpretations') },
	handler: async (ctx, args): Promise<ReduceResult | null> => {
		const row = await ctx.db.get(args.interpretationId);
		return row ? readResult(row) : null;
	},
});

/** Marks an attempt that read nothing next to a stored good read of the same revision. */
export const ATTEMPT_SUFFIX = '~attempt';

/** What a run needs to know about a stored extraction to reuse it or retry it. */
function extractionSummary(row: Doc<'messageInterpretations'>) {
	return {
		interpretationId: row._id,
		contentRevision: row.contentRevision.endsWith(ATTEMPT_SUFFIX)
			? row.contentRevision.slice(0, -ATTEMPT_SUFFIX.length)
			: row.contentRevision,
		extractorVersion: row.extractorVersion,
		mode: row.mode,
		status: row.status,
		isApplied: row.appliedAt !== undefined,
		hasPayload: row.payload !== undefined,
		retryCount: row.retryCount,
		nextRetryAt: row.nextRetryAt,
		errorCode: row.errorCode,
	};
}

// ── The query ──────────────────────────────────────────────────────────────

export const loadForInterpretation = internalQuery({
	args: { source: interpretationSourceValidator },
	handler: async (ctx, args) => {
		const info = await loadSourceInfo(ctx, args.source);
		if (!info) return null;
		const mode: InterpretMode | null = await resolveThreadMode(ctx, info.threadRef);
		if (!mode) return null;

		// The snapshot taken at enqueue (sources.ts); without one the message is
		// not interpreted, so a retry can never widen what was eligible.
		const snapshot = await loadInterpretSource(ctx, args.source);
		const eligibility: InterpretEligibilitySignals | null = snapshot?.eligibility ?? null;

		const brief = await loadBriefRow(ctx, info.threadRef);
		const now = Date.now();
		const candidates = await loadPromptItemCandidates(ctx, info.threadRef, now);
		const items = selectPromptItems(candidates.rows, now);
		const openItems = await Promise.all(
			items.page.map((item) => toPromptItem(item, info.participants))
		);

		let currentFacts: InterpretInputFact[] = [];
		let isFactsOverflow = false;
		if (mode === 'brief' && info.threadRef.kind === 'mail') {
			const threadId = info.threadRef.id;
			const facts = await ctx.db
				.query('threadFacts')
				.withIndex('by_mail_thread_and_status', (q) =>
					q.eq('mailThreadId', threadId).eq('status', 'current')
				)
				.take(MAX_PROMPT_FACTS + 1);
			isFactsOverflow = facts.length > MAX_PROMPT_FACTS;
			currentFacts = await Promise.all(facts.slice(0, MAX_PROMPT_FACTS).map(toPromptFact));
		}

		const sourceKey = interpretationSourceKey(args.source);
		const current = await ctx.db
			.query('messageInterpretations')
			.withIndex('by_source_current', (q) => q.eq('sourceKey', sourceKey).eq('isCurrent', true))
			.first();
		const counted =
			(await ctx.db
				.query('messageInterpretations')
				.withIndex('by_source_counted', (q) => q.eq('sourceKey', sourceKey).eq('isCounted', true))
				.first()) ?? current;

		return {
			...info,
			mode,
			eligibility,
			brief: {
				interpretationRevision: brief?.interpretationRevision ?? 0,
				deletionEpoch: brief?.deletionEpoch ?? 0,
			},
			openItems,
			isItemsOverflow: items.isOverflow || candidates.isScanCut,
			currentFacts,
			isFactsOverflow,
			locales: [...INTERPRET_LOCALES],
			ownerLocale: await ownerLocale(ctx, info.ownerUserId),
			timezone: await ownerTimeZone(ctx, info.ownerUserId),
			// The source's current extraction (the last good read, which the replay
			// folds in) and its counted one (the newest attempt). A run reuses a
			// stored extraction only on an exact match of both (run.ts).
			current: current ? extractionSummary(current) : null,
			counted: counted ? extractionSummary(counted) : null,
		};
	},
});
