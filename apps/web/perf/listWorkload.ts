/**
 * Synthetic rows for the mail list scenarios: a Postbox folder and the Team
 * Inbox thread list.
 *
 * Pure and deterministic like perf/workload.ts: the same seed builds the same
 * rows everywhere. Every timestamp sits before {@link SCENARIO_NOW}, the clock
 * the runner pins in the page, so the rows' relative times ("5m", "3h",
 * "Sep 12") and the inbox waiting chips render the same on every run.
 */
import { SCENARIO_NOW } from './browserContext';
import { seededRandom } from './workload';

type Random = () => number;

const pick = <T>(rand: Random, items: readonly T[]): T =>
	items[Math.floor(rand() * items.length)] as T;
const between = (rand: Random, min: number, max: number) =>
	min + Math.floor(rand() * (max - min + 1));

const PEOPLE = [
	['Ada Lovelace', 'ada@owlat.example'],
	['Grace Hopper', 'grace@owlat.example'],
	['Alan Turing', 'alan@owlat.example'],
	['Katherine Johnson', 'katherine@owlat.example'],
	['Edsger Dijkstra', 'edsger@owlat.example'],
	['Barbara Liskov', 'barbara@owlat.example'],
	['Billing', 'billing@example.com'],
	['Weekly digest', 'digest@example.com'],
] as const;

const SUBJECTS = [
	'Quarterly report draft',
	'Re: delivery issue on the welcome campaign',
	'Invoice for September',
	'Can we move the review to Thursday?',
	'Your domain verification is complete',
	'Re: Re: segment export missing rows',
	'Contract renewal',
	'New signup from the pricing page',
] as const;

const SNIPPETS = [
	'Thanks for the quick turnaround, I had a look at the numbers and most of them line up with what we saw last quarter.',
	'Attached is the latest version with the comments from Monday folded in.',
	'Could you check whether the bounce rate on the second send is expected?',
	'Short one: the call moved to 3pm, same link as before.',
	'We noticed a spike in deferrals from one provider overnight; details below.',
] as const;

/**
 * The fields of a folder row (`PostboxThreadRowMessage`) the scenario sets.
 * Declared here because the fixture's typecheck does not read `.vue` files.
 */
export interface SyntheticPostboxRow {
	_id: string;
	mailboxId: string;
	threadId: string;
	fromName: string;
	fromAddress: string;
	subject: string;
	snippet: string;
	receivedAt: number;
	flagSeen: boolean;
	flagFlagged: boolean;
	hasAttachments: boolean;
	pinnedAt?: number;
}

interface PostboxListOptions {
	seed: number;
	rows: number;
	/** Hours back from the pinned clock the folder's mail spans. */
	spanHours: number;
}

/**
 * A folder's loaded rows, newest first, the way the folder query returns them:
 * mostly read mail, some unread, a few starred, pinned or with attachments.
 */
export function postboxListWorkload(options: PostboxListOptions): SyntheticPostboxRow[] {
	const { seed, rows, spanHours } = options;
	const rand = seededRandom(seed);
	const step = (spanHours * 3600 * 1000) / Math.max(1, rows);
	return Array.from({ length: rows }, (_, i) => {
		const [fromName, fromAddress] = pick(rand, PEOPLE);
		const roll = rand();
		return {
			_id: `perf-mail-${i}`,
			mailboxId: 'perf-mailbox',
			threadId: `perf-thread-${i}`,
			fromName,
			fromAddress,
			subject: pick(rand, SUBJECTS),
			snippet: pick(rand, SNIPPETS),
			receivedAt: SCENARIO_NOW - 60_000 - Math.round(i * step),
			flagSeen: roll >= 0.3,
			flagFlagged: rand() < 0.08,
			hasAttachments: rand() < 0.15,
			...(i % 40 === 3 ? { pinnedAt: SCENARIO_NOW - 86_400_000 } : {}),
		};
	});
}

/** The rows after one live change: the row at `index` marked read, everything else as delivered. */
export function markRead(
	rows: readonly SyntheticPostboxRow[],
	index: number
): SyntheticPostboxRow[] {
	const target = rows[index];
	if (!target) throw new Error(`no row ${index} to mark read`);
	if (target.flagSeen) throw new Error(`row ${index} is already read`);
	return rows.map((row, i) => (i === index ? { ...row, flagSeen: true } : row));
}

/** The first unread row at or after `from`: the one a live update changes. */
export function firstUnread(rows: readonly SyntheticPostboxRow[], from = 0): number {
	const index = rows.findIndex((row, i) => i >= from && !row.flagSeen);
	if (index < 0) throw new Error('the workload has no unread row');
	return index;
}

/** The fields of a `listThreads` row (`InboxThreadRowThread`) the scenario sets. */
export interface SyntheticInboxThread {
	_id: string;
	_creationTime: number;
	subject: string;
	contactIdentifier: string;
	status: 'open' | 'waiting';
	latestDraftStatus: 'pending' | null;
	lastMessageAt: number;
	messageCount: number;
	lastPreview: string;
	unread: boolean;
	assignedTo: string | null;
	assignee: { name: string; email: string; image: null } | null;
	responseDueAt?: number;
}

/** Members of the synthetic team: the assignees and the hover picker's list. */
export const INBOX_MEMBERS = PEOPLE.slice(0, 4).map(([name, email], i) => ({
	userId: `perf-member-${i}`,
	name,
	email,
	image: null,
}));

interface TeamInboxOptions {
	seed: number;
	threads: number;
	/** Hours back from the pinned clock the threads' last messages span. */
	spanHours: number;
}

/**
 * The Team Inbox's loaded threads, newest activity first: open threads waiting
 * on the team (with their aging chips), some with a running reply deadline,
 * some assigned, unread or carrying a pending draft.
 */
export function teamInboxWorkload(options: TeamInboxOptions): SyntheticInboxThread[] {
	const { seed, threads, spanHours } = options;
	const rand = seededRandom(seed);
	const step = (spanHours * 3600 * 1000) / Math.max(1, threads);
	return Array.from({ length: threads }, (_, i) => {
		const [, contact] = pick(rand, PEOPLE);
		const lastMessageAt = SCENARIO_NOW - 120_000 - Math.round(i * step);
		const member = rand() < 0.5 ? pick(rand, INBOX_MEMBERS) : null;
		const roll = rand();
		return {
			_id: `perf-team-thread-${i}`,
			_creationTime: lastMessageAt - between(rand, 1, 72) * 3600 * 1000,
			subject: pick(rand, SUBJECTS),
			contactIdentifier: contact,
			status: roll < 0.8 ? ('open' as const) : ('waiting' as const),
			latestDraftStatus: rand() < 0.15 ? ('pending' as const) : null,
			lastMessageAt,
			messageCount: between(rand, 1, 12),
			lastPreview: pick(rand, SNIPPETS),
			unread: rand() < 0.35,
			assignedTo: member?.userId ?? null,
			assignee: member ? { name: member.name, email: member.email, image: null } : null,
			...(i % 5 === 0 ? { responseDueAt: lastMessageAt + 4 * 3600 * 1000 } : {}),
		};
	});
}

/** The threads after one live change: the thread at `index` read by the viewer. */
export function markThreadRead(
	threads: readonly SyntheticInboxThread[],
	index: number
): SyntheticInboxThread[] {
	const target = threads[index];
	if (!target?.unread) throw new Error(`thread ${index} is not unread`);
	return threads.map((thread, i) => (i === index ? { ...thread, unread: false } : thread));
}
