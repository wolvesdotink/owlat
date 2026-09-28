/**
 * A Workbench's model — pure assembly of one mailbox's digest (Postbox), or of
 * the team inbox's informational updates, into the bands the page shows:
 *
 *   - What changed  threads the viewer already knew that moved since they looked
 *   - Important     what people told them and alerts that want action (no reply
 *                   needed), one summarised sentence each
 *   - Also arrived  routine but real mail, one line each
 *   + "Filed away": newsletters, notifications, receipts, promotions and spam as
 *     counts with a few sender names — never as lines
 *
 * Which of these a conversation lands in is decided on the server
 * (`today/triage.ts`); this module only honours it. It still takes a list of
 * digests, so a combined view stays possible.
 *
 * Every line carries the email(s) it summarises as `sources`, so the page can
 * link each phrase back to its origin. Pure — no Vue, no Convex — so the
 * grouping rules stay unit-testable.
 */

import { parseAddress } from '@owlat/shared';

export type TodaySourceKind = 'mail' | 'team';

export interface TodaySource {
	kind: TodaySourceKind;
	/** mailMessages id (mail) or inboundMessages id (team). */
	id: string;
	/** mailThreads id (mail) or conversationThreads id (team). */
	threadId: string;
	mailboxId: string | null;
	fromName: string | null;
	fromAddress: string;
	subject: string;
	snippet: string;
	at: number;
}

export interface TodayLine {
	key: string;
	/** Who it is from, shown before the sentence ("Harbor Design"). */
	lead: string;
	/** The sentence itself — a summary when one exists, else the subject. */
	text: string;
	/** Whether `text` is a real summary (vs a bare subject line). */
	isSummary: boolean;
	sources: TodaySource[];
	/** The inbox it arrived in; `team` for the team inbox. */
	inboxId: string | 'team';
	/** Why an important line is important, when that is not just "a person wrote". */
	reason: ImportantReason | null;
	at: number;
	/** Team-inbox updates can be dismissed / sent to the Answer queue. */
	inboundMessageId: string | null;
}

export interface TodayChange {
	key: string;
	subject: string;
	inboxId: string;
	newMessages: number;
	/** A fresh thread summary, when the summary cache still covers the thread. */
	summary: string | null;
	latest: TodaySource | null;
	sources: TodaySource[];
	at: number;
}

export type FiledKey = 'newsletter' | 'notification' | 'receipt' | 'promotion' | 'spam';
export type ImportantReason = 'person' | 'new_sender' | 'alert';

export interface TodayModel {
	newMail: number;
	isNewMailCapped: boolean;
	changed: TodayChange[];
	/** Changed threads that did not fit (never dropped silently). */
	changedHidden: number;
	worth: TodayLine[];
	also: TodayLine[];
	/** Updates that did not fit (never dropped silently). */
	alsoHidden: number;
	filed: Record<FiledKey, number>;
	/** A few sender names per filed category, newest first. */
	filedSenders: Record<FiledKey, string[]>;
	filedTotal: number;
}

/** What `today.mailbox.digest` returns (the fields this module reads). */
export interface MailboxDigest {
	mailboxId: string;
	newMail: number;
	isNewMailCapped: boolean;
	changed: Array<{
		threadId: string;
		mailboxId: string;
		subject: string;
		newMessages: number;
		lastMessageAt: number;
		snippet: string;
		summary: string | null;
		summaryRequest?: SummaryRequest;
		sources: DigestSource[];
	}>;
	arrived: Array<{
		threadId: string;
		mailboxId: string;
		subject: string;
		snippet: string;
		summary: string | null;
		category: string | null;
		/** Server triage; absent on digests from before it existed. */
		bucket?: 'important' | 'routine';
		reason?: ImportantReason | null;
		lastMessageAt: number;
		summaryRequest?: SummaryRequest;
		sources: DigestSource[];
	}>;
	filed: Record<FiledKey, number>;
	filedSenders?: Partial<Record<FiledKey, string[]>>;
}

/** What to ask the summarizer for when a line has no sentence yet. */
export interface SummaryRequest {
	messageId: string | null | undefined;
	sinceCount: number;
}

/** Lines still showing a bare subject, as summarizer requests (deduped, newest first). */
export function missingSummaries(
	digests: ReadonlyArray<MailboxDigest | null | undefined>
): Array<{ messageId: string; sinceCount: number }> {
	const out: Array<{ messageId: string; sinceCount: number; at: number }> = [];
	for (const digest of digests) {
		if (!digest) continue;
		for (const item of [...digest.changed, ...digest.arrived]) {
			const request = item.summaryRequest;
			if (item.summary || !request?.messageId) continue;
			out.push({
				messageId: request.messageId,
				sinceCount: request.sinceCount,
				at: item.lastMessageAt,
			});
		}
	}
	return out
		.sort((a, b) => b.at - a.at)
		.map(({ messageId, sinceCount }) => ({ messageId, sinceCount }));
}

interface DigestSource {
	messageId: string;
	fromName: string | null;
	fromAddress: string;
	subject: string;
	snippet: string;
	receivedAt: number;
}

/** A team-inbox informational update (the fields this module reads). */
export interface TeamUpdate {
	message: {
		_id: string;
		threadId?: string | null;
		from: string;
		subject: string;
		receivedAt: number;
		classification?: {
			importance?: number;
			priority?: string;
			summary?: Record<string, string>;
		} | null;
	};
}

export interface TeamUpdateCounts {
	promotions: number;
	notifications: number;
	spam: number;
}

/** Team updates at or above this importance are "worth knowing". */
export const WORTH_KNOWING_IMPORTANCE = 0.5;
const MAX_CHANGED = 8;
const MAX_WORTH = 8;
const MAX_ALSO = 8;
/** Sender names kept per filed category after merging digests. */
const FILED_SENDER_LIMIT = 3;

function senderName(fromName: string | null, fromAddress: string): string {
	const name = fromName?.trim();
	if (name) return name;
	const local = fromAddress.split('@', 1)[0] ?? fromAddress;
	return local.charAt(0).toUpperCase() + local.slice(1);
}

/**
 * "Ines Weber <Ines@x.io>" → { name: "Ines Weber", address: "ines@x.io" }.
 * Goes through the shared RFC 5322 parser, so an RFC 2047 encoded name comes
 * back decoded and the address lowercased. A value with no parseable address is
 * kept as the address, trimmed, so the line still names something.
 */
export function parseFromHeader(from: string): { name: string | null; address: string } {
	const parsed = parseAddress(from);
	return parsed
		? { name: parsed.name ?? null, address: parsed.address }
		: { name: null, address: from.trim() };
}

function mailSource(mailboxId: string, threadId: string, s: DigestSource): TodaySource {
	return {
		kind: 'mail',
		id: s.messageId,
		threadId,
		mailboxId,
		fromName: s.fromName,
		fromAddress: s.fromAddress,
		subject: s.subject,
		snippet: s.snippet,
		at: s.receivedAt,
	};
}

export function buildTodayModel(input: {
	digests: ReadonlyArray<MailboxDigest | null | undefined>;
	teamUpdates: ReadonlyArray<TeamUpdate>;
	teamCounts: TeamUpdateCounts | null;
	since: number;
	/** Pick the reader-locale summary out of a per-locale record. */
	pickSummary: (summary: Record<string, string> | undefined) => string | null;
}): TodayModel {
	const filed: Record<FiledKey, number> = {
		newsletter: 0,
		notification: 0,
		receipt: 0,
		promotion: 0,
		spam: 0,
	};
	const filedSenders: Record<FiledKey, string[]> = {
		newsletter: [],
		notification: [],
		receipt: [],
		promotion: [],
		spam: [],
	};
	let newMail = 0;
	let isNewMailCapped = false;
	const changed: TodayChange[] = [];
	const worth: TodayLine[] = [];
	const also: TodayLine[] = [];

	for (const digest of input.digests) {
		if (!digest) continue;
		newMail += digest.newMail;
		isNewMailCapped ||= digest.isNewMailCapped;
		for (const key of Object.keys(filed) as FiledKey[]) {
			filed[key] += digest.filed[key] ?? 0;
			for (const name of digest.filedSenders?.[key] ?? []) {
				const list = filedSenders[key];
				if (list.length < FILED_SENDER_LIMIT && !list.includes(name)) list.push(name);
			}
		}
		for (const c of digest.changed) {
			const sources = c.sources.map((s) => mailSource(c.mailboxId, c.threadId, s));
			changed.push({
				key: `mail:${c.threadId}`,
				subject: c.subject,
				inboxId: c.mailboxId,
				newMessages: c.newMessages,
				summary: c.summary,
				latest: sources[0] ?? null,
				sources,
				at: c.lastMessageAt,
			});
		}
		for (const a of digest.arrived) {
			const sources = a.sources.map((s) => mailSource(a.mailboxId, a.threadId, s));
			const first = sources[0];
			const line: TodayLine = {
				key: `mail:${a.threadId}`,
				lead: first ? senderName(first.fromName, first.fromAddress) : '',
				text: a.summary ?? a.subject,
				isSummary: a.summary !== null,
				sources,
				inboxId: a.mailboxId,
				reason: a.reason ?? null,
				at: a.lastMessageAt,
				inboundMessageId: null,
			};
			const important = a.bucket
				? a.bucket === 'important'
				: a.category === null || a.category === 'person';
			if (important) worth.push(line);
			else also.push(line);
		}
	}

	for (const update of input.teamUpdates) {
		const m = update.message;
		if (m.receivedAt <= input.since) continue;
		const from = parseFromHeader(m.from);
		const summary = input.pickSummary(m.classification?.summary);
		const line: TodayLine = {
			key: `team:${m._id}`,
			lead: senderName(from.name, from.address),
			text: summary ?? m.subject,
			isSummary: summary !== null,
			sources: [
				{
					kind: 'team',
					id: m._id,
					threadId: m.threadId ?? '',
					mailboxId: null,
					fromName: from.name,
					fromAddress: from.address,
					subject: m.subject,
					snippet: '',
					at: m.receivedAt,
				},
			],
			inboxId: 'team',
			reason: null,
			at: m.receivedAt,
			inboundMessageId: m._id,
		};
		const importance = m.classification?.importance ?? 0;
		if (importance >= WORTH_KNOWING_IMPORTANCE || m.classification?.priority === 'urgent') {
			worth.push(line);
		} else {
			also.push(line);
		}
	}

	if (input.teamCounts) {
		filed.promotion += input.teamCounts.promotions;
		filed.notification += input.teamCounts.notifications;
		filed.spam += input.teamCounts.spam;
	}

	const byNewest = <T extends { at: number }>(a: T, b: T) => b.at - a.at;
	const changedSorted = changed.sort(byNewest);
	const worthSorted = worth.sort(byNewest);
	// Overflow from "worth knowing" still has to be seen: it moves down, never away.
	const alsoAll = [...worthSorted.slice(MAX_WORTH), ...also].sort(byNewest);
	return {
		newMail,
		isNewMailCapped,
		changed: changedSorted.slice(0, MAX_CHANGED),
		changedHidden: Math.max(0, changedSorted.length - MAX_CHANGED),
		worth: worthSorted.slice(0, MAX_WORTH),
		also: alsoAll.slice(0, MAX_ALSO),
		alsoHidden: Math.max(0, alsoAll.length - MAX_ALSO),
		filed,
		filedSenders,
		filedTotal: Object.values(filed).reduce((sum, n) => sum + n, 0),
	};
}
