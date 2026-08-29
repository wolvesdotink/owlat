/**
 * Suggest rules from observed behaviour (idea 27).
 *
 * The filter engine is powerful and entirely manual. Someone can archive on
 * sight from the same sender forty times and the system says nothing. This
 * module is the smallest honest fix: a bounded per-sender tally of the triage
 * verbs actually used, and — when ONE verb clearly dominates for a sender — a
 * dismissible offer in the reader footer that creates the matching filter in one
 * click, with an undo and a link to the rule it made.
 *
 * THREE PROPERTIES, and none of them is negotiable:
 *
 *   1. STRICTLY OPT-IN. Nothing is ever auto-applied. The tally only ever
 *      produces an OFFER — the same posture `autonomySuggestions` takes for
 *      autonomy graduation, where the cron records a nudge instead of loosening
 *      a threshold itself.
 *   2. RECURRENCE, not volume. A suggestion needs both {@link MIN_OCCURRENCES}
 *      messages AND {@link MIN_SESSIONS} separate triage actions, so a single
 *      bulk sweep over a backlog can never manufacture a rule. Same gate the
 *      edit-learning flywheel puts on `mailVoiceProfiles.derivedAdjustments`.
 *   3. BOUNDED AND FORGETFUL. A counter per (mailbox, sender, verb) — no message
 *      ids, no subjects — capped per mailbox with least-recently-touched
 *      eviction, and pruned by a retention cron. Habits from a year ago are not
 *      evidence about today.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { mailTriageVerbValidator, type MailTriageVerb } from '../lib/mailContentValidators';
import type { Doc, Id } from '../_generated/dataModel';
import { requireMailboxAccess } from './permissions';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';

/** Messages triaged the same way before a suggestion is even considered. */
export const MIN_OCCURRENCES = 5;

/**
 * Separate triage ACTIONS those messages came from. Volume alone is not a habit:
 * archiving twelve newsletters in one sweep says something about the backlog,
 * not about what should happen to the next one.
 */
export const MIN_SESSIONS = 3;

/**
 * Share of a sender's triage the winning verb must hold. Below this the user is
 * doing different things with this sender's mail, and a rule would be wrong for
 * some of it.
 */
export const DOMINANCE_RATIO = 0.8;

/** Distinct sender rows one mailbox keeps. Least-recently-touched is evicted. */
export const MAX_TALLY_SENDERS = 500;

/** Messages a single triage call records. A bulk sweep is one session, not 500 writes. */
export const MAX_RECORDED_PER_CALL = 100;

/** How long an untouched tally row survives the retention sweep (90 days). */
export const TALLY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Rows the retention cron prunes per tick. */
const RETENTION_BATCH = 200;

/** The shape the dominance predicate needs from a tally row. */
export interface TallyLike {
	verb: MailTriageVerb;
	count: number;
	sessions: number;
	dismissedAt?: number | undefined;
	actedFilterId?: unknown;
}

export interface TriageSuggestion {
	verb: MailTriageVerb;
	count: number;
	/** Everything tallied for this sender, so the UI can be honest about share. */
	total: number;
}

/**
 * Does one sender's tally justify offering a rule?
 *
 * Pure, so the gate is testable without a database. Dominance is measured
 * against EVERY verb tallied for the sender — including verbs already dismissed
 * or acted on — because that is the behavioural truth; only the eligibility of
 * the winner is filtered, so declining "always archive" does not silently
 * promote "always trash" on the same evidence.
 */
export function triageSuggestionFor(tallies: readonly TallyLike[]): TriageSuggestion | null {
	const total = tallies.reduce((sum, t) => sum + t.count, 0);
	if (total === 0) return null;

	let best: TallyLike | null = null;
	for (const tally of tallies) {
		if (tally.dismissedAt !== undefined || tally.actedFilterId) continue;
		if (tally.count < MIN_OCCURRENCES || tally.sessions < MIN_SESSIONS) continue;
		if (tally.count / total < DOMINANCE_RATIO) continue;
		if (!best || tally.count > best.count) best = tally;
	}
	return best ? { verb: best.verb, count: best.count, total } : null;
}

// ── Recording (called by the triage mutations) ────────────────────

/**
 * Record ONE triage action over a set of messages.
 *
 * Called from `mail/messageActions.ts` after the move has been authorized, so
 * this never decides access. Deliberately best-effort and side-effect-free for
 * the caller: a mailbox at the sender cap silently drops the least recently
 * touched row rather than failing the archive the user actually asked for.
 *
 * `ctx`-only (no session): the retroactive filter sweep also moves mail, and
 * only the human-initiated wrappers call this — a rule's own work must never
 * become evidence for suggesting that rule again.
 */
export async function recordTriageVerb(
	ctx: MutationCtx,
	messageIds: Id<'mailMessages'>[],
	verb: MailTriageVerb
): Promise<void> {
	// One session per call, however many messages it covered — that is the whole
	// point of counting sessions separately from messages.
	const perSender = new Map<string, { mailboxId: Id<'mailboxes'>; count: number }>();
	for (const id of messageIds.slice(0, MAX_RECORDED_PER_CALL)) {
		const message = await ctx.db.get(id);
		if (!message) continue;
		const sender = message.fromAddress.trim().toLowerCase();
		if (!sender) continue;
		const key = `${message.mailboxId}|${sender}`;
		const entry = perSender.get(key) ?? { mailboxId: message.mailboxId, count: 0 };
		entry.count += 1;
		perSender.set(key, entry);
	}

	const now = Date.now();
	for (const [key, entry] of perSender) {
		const sender = key.slice(key.indexOf('|') + 1);
		const existing = await ctx.db
			.query('mailTriageTallies')
			.withIndex('by_mailbox_and_sender', (q) =>
				q.eq('mailboxId', entry.mailboxId).eq('senderAddress', sender)
			)
			.collect(); // bounded: at most one row per verb
		const row = existing.find((r) => r.verb === verb);
		if (row) {
			await ctx.db.patch(row._id, {
				count: row.count + entry.count,
				sessions: row.sessions + 1,
				lastAt: now,
				updatedAt: now,
			});
			continue;
		}
		if (existing.length === 0) await evictIfAtCap(ctx, entry.mailboxId, now);
		await ctx.db.insert('mailTriageTallies', {
			mailboxId: entry.mailboxId,
			senderAddress: sender,
			verb,
			count: entry.count,
			sessions: 1,
			firstAt: now,
			lastAt: now,
			createdAt: now,
			updatedAt: now,
		});
	}
}

/**
 * Keep a mailbox's tally under {@link MAX_TALLY_SENDERS} by dropping the least
 * recently touched rows. A cap that REFUSED new rows would freeze the picture at
 * whichever 500 senders happened to be seen first, which is the opposite of what
 * "recent habits" means.
 */
async function evictIfAtCap(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	now: number
): Promise<void> {
	const rows = await ctx.db
		.query('mailTriageTallies')
		.withIndex('by_mailbox_and_last', (q) => q.eq('mailboxId', mailboxId))
		.order('asc')
		.take(MAX_TALLY_SENDERS + 1);
	if (rows.length <= MAX_TALLY_SENDERS) return;
	for (const row of rows.slice(0, rows.length - MAX_TALLY_SENDERS)) {
		// Never evict a row the user acted on: it is the record behind a live
		// rule's undo, not an observation.
		if (row.actedFilterId) continue;
		if (row.lastAt >= now) continue;
		await ctx.db.delete(row._id);
	}
}

// ── Retention ─────────────────────────────────────────────────────

/** Drop tally rows nothing has touched inside the retention window. */
export const pruneTallies = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ pruned: number }> => {
		const cutoff = Date.now() - TALLY_RETENTION_MS;
		const stale = await ctx.db
			.query('mailTriageTallies')
			.withIndex('by_last', (q) => q.lt('lastAt', cutoff))
			.take(RETENTION_BATCH);
		let pruned = 0;
		for (const row of stale) {
			// An accepted suggestion's row is the undo's anchor — it outlives the
			// observation window on purpose.
			if (row.actedFilterId) continue;
			await ctx.db.delete(row._id);
			pruned += 1;
		}
		return { pruned };
	},
});

// ── Reader-footer read ────────────────────────────────────────────

/**
 * The suggestion (or the accepted rule) for the sender of one message.
 *
 * Returns null for anonymous callers, for a message the viewer cannot read, and
 * — the common case by far — when the sender's tally has not earned an offer.
 */
// public: soft-auth — returns null for anonymous; mailbox access is still enforced in-handler
export const forMessage = publicQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (
		ctx,
		args
	): Promise<{
		mailboxId: Id<'mailboxes'>;
		senderAddress: string;
		suggestion: TriageSuggestion | null;
		/** Set when the user already accepted a suggestion for this sender. */
		accepted: { verb: MailTriageVerb; filterId: Id<'mailFilters'>; filterName: string } | null;
	} | null> => {
		const message = await ctx.db.get(args.messageId);
		if (!message) return null;
		const owned = await requireMailboxAccess(ctx, message.mailboxId);
		if (!owned.ok) return null;

		const senderAddress = message.fromAddress.trim().toLowerCase();
		if (!senderAddress) return null;
		const tallies = await ctx.db
			.query('mailTriageTallies')
			.withIndex('by_mailbox_and_sender', (q) =>
				q.eq('mailboxId', message.mailboxId).eq('senderAddress', senderAddress)
			)
			.collect(); // bounded: at most one row per verb

		const actedRow = tallies.find((t) => t.actedFilterId);
		const filter = actedRow?.actedFilterId ? await ctx.db.get(actedRow.actedFilterId) : null;
		return {
			mailboxId: message.mailboxId,
			senderAddress,
			// An accepted rule replaces the offer; nothing is suggested on top of it.
			suggestion: filter ? null : triageSuggestionFor(tallies),
			accepted:
				actedRow && filter
					? { verb: actedRow.verb, filterId: filter._id, filterName: filter.name }
					: null,
		};
	},
});

// ── Accept / dismiss / undo ───────────────────────────────────────

/**
 * Turn an offered suggestion into a real filter. One click, and the rule is an
 * ordinary `mailFilters` row from that moment on — editable, disableable and
 * deletable in Filters like any other, which is why nothing here is a special
 * "suggested rule" kind.
 *
 * The gate is re-evaluated server-side from the stored tally: the client cannot
 * ask for a rule the evidence does not support.
 */
export const acceptSuggestion = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		senderAddress: v.string(),
		verb: mailTriageVerbValidator,
		/** Filter name, localized by the caller (the reader knows the language). */
		name: v.string(),
	},
	handler: async (ctx, args): Promise<{ filterId: Id<'mailFilters'> }> => {
		// Creating a filter changes how a mailbox routes mail for everyone who
		// uses it — the same owner-grade bar `mail/filters.ts::create` sets.
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		const sender = args.senderAddress.trim().toLowerCase();
		const tallies = await ctx.db
			.query('mailTriageTallies')
			.withIndex('by_mailbox_and_sender', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('senderAddress', sender)
			)
			.collect(); // bounded: at most one row per verb
		const suggestion = triageSuggestionFor(tallies);
		if (!suggestion || suggestion.verb !== args.verb) {
			throwInvalidInput('That suggestion is no longer on offer');
		}
		const row = tallies.find((t) => t.verb === args.verb);
		if (!row) throwInvalidInput('That suggestion is no longer on offer');

		const now = Date.now();
		const filterId = await ctx.db.insert('mailFilters', {
			mailboxId: args.mailboxId,
			name: args.name.trim().slice(0, 120) || `Mail from ${sender}`,
			isEnabled: true,
			// Appended at the end of the run order rather than jumped to the front:
			// a rule the user merely accepted must not silently outrank rules they
			// wrote and ordered themselves.
			priority: await nextPriority(ctx, args.mailboxId),
			conditions: [{ field: 'from', op: 'equals', value: sender }],
			actions: await actionsForVerb(ctx, args.mailboxId, args.verb),
			stopProcessing: false,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(row._id, { actedFilterId: filterId, updatedAt: now });
		return { filterId };
	},
});

/** Decline a suggestion. It never comes back for this sender+verb. */
export const dismissSuggestion = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		senderAddress: v.string(),
		verb: mailTriageVerbValidator,
	},
	handler: async (ctx, args): Promise<void> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const row = await findTally(ctx, args.mailboxId, args.senderAddress, args.verb);
		if (!row || row.dismissedAt !== undefined) return;
		await ctx.db.patch(row._id, { dismissedAt: Date.now(), updatedAt: Date.now() });
	},
});

/**
 * Undo an accepted suggestion: delete the rule it created and put the tally back
 * to a state that does not re-offer it. The undo is the reason accepting is
 * safe, so it removes the rule outright rather than disabling it — a disabled
 * rule the user never asked for is still clutter in their Filters list.
 */
export const undoSuggestion = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		senderAddress: v.string(),
		verb: mailTriageVerbValidator,
	},
	handler: async (ctx, args): Promise<void> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const row = await findTally(ctx, args.mailboxId, args.senderAddress, args.verb);
		if (!row?.actedFilterId) return;
		const filter = await ctx.db.get(row.actedFilterId);
		// Only ever delete the row we created for this mailbox — never a rule the
		// user has since re-pointed somewhere else.
		if (filter && filter.mailboxId === args.mailboxId) await ctx.db.delete(filter._id);
		const now = Date.now();
		await ctx.db.patch(row._id, {
			actedFilterId: undefined,
			// Undoing IS a "no": re-offering the same rule the moment it is undone
			// would be a nag, so the offer stays retired for this sender+verb.
			dismissedAt: now,
			updatedAt: now,
		});
	},
});

// ── Helpers ───────────────────────────────────────────────────────

async function findTally(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	senderAddress: string,
	verb: MailTriageVerb
): Promise<Doc<'mailTriageTallies'> | undefined> {
	const rows = await ctx.db
		.query('mailTriageTallies')
		.withIndex('by_mailbox_and_sender', (q) =>
			q.eq('mailboxId', mailboxId).eq('senderAddress', senderAddress.trim().toLowerCase())
		)
		.collect(); // bounded: at most one row per verb
	return rows.find((r) => r.verb === verb);
}

/** Append at the end of the run order, matching `mail/filters.ts::create`. */
async function nextPriority(ctx: MutationCtx, mailboxId: Id<'mailboxes'>): Promise<number> {
	const existing = await ctx.db
		.query('mailFilters')
		.withIndex('by_mailbox_and_priority', (q) => q.eq('mailboxId', mailboxId))
		.collect(); // bounded: one mailbox's filters
	return existing.length === 0 ? 100 : Math.max(...existing.map((f) => f.priority)) + 100;
}

/**
 * The filter actions one observed verb becomes. `archive` and `spam` need their
 * system folder; when it is missing the verb has no honest translation, so the
 * rule falls back to nothing rather than inventing a destructive one.
 */
async function actionsForVerb(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	verb: MailTriageVerb
): Promise<Array<{ type: 'moveToFolder' | 'delete'; folderId?: Id<'mailFolders'> }>> {
	if (verb === 'trash') return [{ type: 'delete' }];
	const role = verb === 'archive' ? 'archive' : 'spam';
	const folder = await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', role))
		.first();
	if (!folder) throwInvalidInput(`The ${role} folder is missing`);
	return [{ type: 'moveToFolder', folderId: folder._id }];
}
