/**
 * The People view's pure derivations over the directory read
 * (`mail/people/directory.ts`): the column's sections, search, what a person
 * or company page shows, and the periods the Earlier list is grouped by.
 *
 * Kept apart from the components so the grouping rules are tested without
 * mounting anything.
 */

import type { InjectionKey, Ref } from 'vue';
import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';

export type PeopleDirectory = NonNullable<
	FunctionReturnType<typeof api.mail.people.directory.directory>
>;
export type PeoplePerson = PeopleDirectory['people'][number];
export type PeopleAccount = PeopleDirectory['accounts'][number];
export type PeopleCompany = PeopleDirectory['companies'][number];
export type PeopleTopic = PeopleDirectory['topics'][number];

/** Which page the main pane shows. */
export type PeopleSelection = { kind: 'person'; key: string } | { kind: 'company'; key: string };

export interface PeopleSections {
	/** A topic waits on the mailbox, on evidence (a request was read). */
	waiting: PeoplePerson[];
	/** Nothing waits on evidence, but a flag says a reply may be due. */
	maybe: PeoplePerson[];
	/** A current topic, none waiting on the mailbox. */
	active: PeoplePerson[];
	/** Nothing current. */
	quiet: PeoplePerson[];
	/** Companies with a system account, or two people or more. */
	companies: PeopleCompany[];
}

/** A company is worth its own row once it is more than one person's domain. */
export function isListedCompany(company: PeopleCompany): boolean {
	return company.accountKeys.length > 0 || company.personKeys.length >= 2;
}

export function normalize(text: string): string {
	return text
		.toLocaleLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '');
}

/** Does `query` match the person: name, address, company or one of their topic titles. */
function personMatches(
	person: PeoplePerson,
	terms: string[],
	companyName: string | undefined,
	titles: string[]
): boolean {
	const haystack = normalize([person.name, person.email, companyName ?? '', ...titles].join(' '));
	return terms.every((term) => haystack.includes(term));
}

export function peopleSections(directory: PeopleDirectory, query: string): PeopleSections {
	const terms = searchTerms(query);
	const companyName = new Map(directory.companies.map((c) => [c.key, c.name]));
	const topicTitle = new Map(directory.topics.map((t) => [t.id, t.title]));
	const titlesOf = (ids: readonly string[]) =>
		ids.map((id) => topicTitle.get(id)).filter((t): t is string => t !== undefined);

	const people = directory.people.filter(
		(p) =>
			terms.length === 0 ||
			personMatches(
				p,
				terms,
				p.companyKey ? companyName.get(p.companyKey) : undefined,
				titlesOf(p.topicIds)
			)
	);
	const companies = directory.companies.filter(
		(c) =>
			isListedCompany(c) &&
			terms.every((term) =>
				normalize([c.name, c.domain ?? '', ...titlesOf(c.topicIds)].join(' ')).includes(term)
			)
	);

	const topicById = new Map(directory.topics.map((t) => [t.id, t]));
	// Whoever waits longest past a due date first, then the most recent.
	const soonestDue = (p: PeoplePerson) =>
		Math.min(...p.topicIds.map((id) => dueOf(topicById.get(id)) ?? Number.POSITIVE_INFINITY));
	const waiting = people
		.filter((p) => p.owedCount > 0)
		.sort((a, b) => soonestDue(a) - soonestDue(b) || b.lastAt - a.lastAt);
	const maybe = people.filter((p) => p.owedCount === 0 && p.mayOweCount > 0);
	const rest = people.filter((p) => p.owedCount === 0 && p.mayOweCount === 0);
	const active = rest.filter((p) => p.currentCount > 0);
	const quiet = rest.filter((p) => p.currentCount === 0);
	return { waiting, maybe, active, quiet, companies };
}

/**
 * `text` cut into the pieces a search matched and the rest, for highlighting.
 * Matching ignores case and accents, like the search itself; folding one
 * character at a time keeps the pieces aligned with the original text.
 */
export function highlightParts(
	text: string,
	terms: readonly string[]
): Array<{ text: string; isHit: boolean }> {
	const folded = [...text]
		.map((c) => {
			const f = normalize(c);
			return f.length === 1 ? f : c.toLocaleLowerCase().slice(0, 1) || c;
		})
		.join('');
	const hits = Array.from({ length: folded.length }, () => false);
	for (const term of terms) {
		if (!term) continue;
		let at = folded.indexOf(term);
		while (at >= 0) {
			hits.fill(true, at, at + term.length);
			at = folded.indexOf(term, at + 1);
		}
	}
	const parts: Array<{ text: string; isHit: boolean }> = [];
	for (const [i, c] of [...text].entries()) {
		const last = parts.at(-1);
		const isHit = hits[i] ?? false;
		if (last && last.isHit === isHit) last.text += c;
		else parts.push({ text: c, isHit });
	}
	return parts;
}

/**
 * The sentence in a preview that asks something (a question, or one opening
 * with please/bitte), for a row whose only status is "may need a reply". Display
 * only: the server's `asksSomething` decides whether the row is a maybe at all.
 */
export function askingSentence(snippet: string): string | null {
	const sentences = previewText(snippet).split(/(?<=[.?!])\s+/);
	return (
		sentences.find((x) => x.includes('?')) ??
		sentences.find((x) => /^(please|could you|can you|bitte|kannst du)\b/i.test(x)) ??
		null
	);
}

/**
 * A request's due date as every People surface shows it: the short date, and
 * whether it is overdue, counted in calendar days (due today is not overdue).
 */
export function dueParts(
	at: number,
	locale: string,
	now: number = Date.now()
): { date: string; isOverdue: boolean } {
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	return {
		date: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(at),
		isOverdue: at < today.getTime(),
	};
}

/**
 * An asking sentence that cannot stand alone ("Would that work for you?")
 * with the topic it is about in front; a full one as it is.
 */
export function askWithContext(ask: string, title: string): string {
	const leans =
		ask.length < 40 ||
		/^(would|does|is|can|could|will) (that|it|this)\b|^(that|it|this)\b/i.test(ask);
	return leans ? `${title} · ${ask}` : ask;
}

/**
 * The Earlier list with the older pages loaded into it. Those pages start from
 * the newest mail, so they repeat what the page already shows (its current
 * conversations, and Earlier itself); those stay out, and the list stays
 * newest first.
 */
export function mergeEarlier(
	earlier: readonly PeopleTopic[],
	older: readonly PeopleTopic[],
	shownElsewhere: readonly string[]
): PeopleTopic[] {
	const known = new Set([...earlier.map((x) => x.id), ...shownElsewhere]);
	return [...earlier, ...older.filter((x) => !known.has(x.id))].sort(
		(a, b) => b.lastMessageAt - a.lastMessageAt
	);
}

export function searchTerms(query: string): string[] {
	return normalize(query).split(/\s+/).filter(Boolean);
}

/** The topic a row leads with: the most pressing current one (`compareUrgency`), else the newest. */
export function leadTopic(
	topicIds: readonly string[],
	topics: ReadonlyMap<string, PeopleTopic>
): PeopleTopic | undefined {
	const own = topicIds.map((id) => topics.get(id)).filter((t): t is PeopleTopic => !!t);
	return own.filter((t) => t.isCurrent).sort(compareUrgency)[0] ?? own[0];
}

/** When a request to us is due, if it says. */
export function dueOf(topic: PeopleTopic | undefined): number | undefined {
	return topic?.isAsk ? topic.openItem?.dueAt : undefined;
}

/**
 * Most pressing first: requests with a due date (soonest first), other
 * requests, turns that only may need a reply, then theirs, then the rest,
 * newest within each. Every list of a person's conversations sorts by it.
 */
export function compareUrgency(a: PeopleTopic, b: PeopleTopic): number {
	const rank = (t: PeopleTopic) =>
		t.isAsk ? (dueOf(t) !== undefined ? 0 : 1) : t.turn === 'you' ? 2 : t.turn === 'them' ? 3 : 4;
	return (
		rank(a) - rank(b) || (dueOf(a) ?? 0) - (dueOf(b) ?? 0) || b.lastMessageAt - a.lastMessageAt
	);
}

/** Current topics in `compareUrgency` order; the rest, newest first, are Earlier. */
export function splitTopics(topics: readonly PeopleTopic[]): {
	now: PeopleTopic[];
	earlier: PeopleTopic[];
} {
	const now = topics.filter((t) => t.isCurrent).sort(compareUrgency);
	const earlier = topics
		.filter((t) => !t.isCurrent)
		.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
	return { now, earlier };
}

export interface TopicPeriod {
	key: string;
	label: string;
	topics: PeopleTopic[];
}

/**
 * The Earlier list's periods: a month for the last twelve months, then a
 * year. `topics` must be newest first.
 */
export function topicPeriods(
	topics: readonly PeopleTopic[],
	now: Date,
	locale: string
): TopicPeriod[] {
	const monthFormat = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' });
	const yearStart = new Date(now.getFullYear(), now.getMonth() - 11, 1).getTime();
	const periods: TopicPeriod[] = [];
	for (const topic of topics) {
		const at = new Date(topic.lastMessageAt);
		const isRecent = topic.lastMessageAt >= yearStart;
		const key = isRecent ? `${at.getFullYear()}-${at.getMonth()}` : `${at.getFullYear()}`;
		let period = periods[periods.length - 1];
		if (period?.key !== key) {
			period = {
				key,
				label: isRecent ? monthFormat.format(at) : String(at.getFullYear()),
				topics: [],
			};
			periods.push(period);
		}
		period.topics.push(topic);
	}
	return periods;
}

/** The URL query that selects a page, merged into the route's own. */
export function selectionQuery(selection: PeopleSelection): Record<string, string> {
	return selection.kind === 'person' ? { person: selection.key } : { company: selection.key };
}

/** The page a route query selects, if any. */
export function selectionFromQuery(query: Record<string, unknown>): PeopleSelection | null {
	const person = query['person'];
	if (typeof person === 'string' && person) return { kind: 'person', key: person };
	const company = query['company'];
	if (typeof company === 'string' && company) return { kind: 'company', key: company };
	return null;
}

/** A salutation and a bare "thanks" opener, which say nothing about the conversation. */
const GREETING =
	/^\s*(hi|hello|hey|dear|hallo|liebe[rs]?|guten (morgen|tag|abend)|moin|servus|good (morning|afternoon|evening))\b[^,.!\n]{0,40}[,.!]\s*(again[,.!]?\s*)?/i;

/** The preview without its greeting, so the line starts with what was said. */
export function stripGreeting(snippet: string): string {
	const stripped = snippet.replace(GREETING, '').trim();
	return stripped.length > 0
		? stripped.charAt(0).toUpperCase() + stripped.slice(1)
		: snippet.trim();
}

/**
 * The topic a reader shows when it was opened from the People view: the reader
 * heads the conversation with its name, and keeps the subject one line under.
 * Absent everywhere else, where the reader shows the subject as it always did.
 */
export interface TopicHeading {
	title: string;
	subject: string;
	/** Who named it; `subject` means nobody did and the title is the subject. */
	source: 'ai' | 'user' | 'subject';
	/** Names the topic; an empty name hands it back to Owlat. */
	rename: (title: string) => Promise<void>;
	/** Hands a name the person wrote back to Owlat. */
	reset: () => Promise<void>;
	/** "No reply needed", while the conversation's turn is the mailbox's. */
	noReply?: () => Promise<void>;
}

export const POSTBOX_TOPIC_HEADING: InjectionKey<Readonly<Ref<TopicHeading | null>>> =
	Symbol('postboxTopicHeading');

/** Reply and forward prefixes, as the server strips them (`mail/people/classify.ts`). */
const SUBJECT_PREFIX = /^\s*((re|aw|sv|antw|wg|fw|fwd|tr|rv|vs)(\[\d+\])?\s*[:：]\s*)+/i;

/** The subject as a topic name would read it: no Re:/Fwd:, one space between words. */
export function cleanedSubject(subject: string): string {
	return subject.replace(SUBJECT_PREFIX, '').replace(/\s+/g, ' ').trim();
}

/** A closing that starts its own sentence ("… Friday? Best,"), not "best" inside one. */
const CLOSING =
	/(^|[.!?]\s+)(best( regards| wishes)?|thanks( again)?|thank you|cheers|kind regards|regards|warm regards|viele grüße|beste grüße|liebe grüße|lg|vg|gruß)[,.!]?\s*$/i;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The preview with neither greeting nor sign-off, so the words that carry the
 * request get the room: the writer's own name at the end, then a closing that
 * starts its own sentence. A sentence that ends in somebody's name stays.
 */
export function previewText(snippet: string, writerFirstName?: string): string {
	let body = stripGreeting(snippet);
	if (writerFirstName) {
		body = body.replace(new RegExp(`[\\s,]+${escapeRegExp(writerFirstName)}[.!]?$`, 'i'), '');
	}
	body = body.replace(CLOSING, '$1').trim();
	return body.length > 0 ? body : snippet.trim();
}
