/**
 * The conversation view's shared types and text helpers over the directory
 * read (`mail/people/directory.ts`): search folding, the preview line without
 * its greeting and sign-off, the asking sentence, and the page in the URL.
 * The pane and page model is `postboxConversations.ts`.
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

export function normalize(text: string): string {
	return text
		.toLocaleLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '');
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

export function searchTerms(query: string): string[] {
	return normalize(query).split(/\s+/).filter(Boolean);
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
	/**
	 * Done (archive underneath) and its way back. The conversation view names
	 * the reader's Archive this way; `isDone` swaps it for Reopen.
	 */
	done?: () => Promise<void>;
	reopen?: () => Promise<void>;
	isDone?: boolean;
	/** What the latest message asks, shown above the reply field. */
	ask?: { author: string | null; text: string };
	/** The reply field at the conversation's foot: not under machine mail. */
	hasReplyField?: boolean;
	/** Whom that field addresses, by first name. */
	replyTo?: string;
	/** A reply was drafted and waits for review in Answer mode. */
	hasSuggestedReply?: boolean;
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
