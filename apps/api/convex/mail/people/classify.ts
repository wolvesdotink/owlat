/**
 * The People view's pure rules: who a thread is with, whether an address is a
 * person or a company account, which company an address belongs to, and
 * whose turn a conversation is.
 *
 * A company account is an organisation's system address (no-reply, billing,
 * shipping, a newsletter). It is shown apart from people, because its mail
 * is not a conversation. A person at a company (lena@lumen.example) stays a
 * person; the company groups them with its accounts by organisational domain.
 *
 * Pure; not a Convex function.
 */

import { normalizeEmail } from '@owlat/shared';
import { organizationalDomain } from '@owlat/shared/dnsZone';
import { isFreemailDomain } from '@owlat/shared/freemailDomains';
import { extractEmail } from '../../lib/emailAddress';
import type { MailCategory } from '../category';

/** Local parts that only machines and departments send from. */
const ROLE_LOCAL_PART =
	/^(no-?reply|do-?not-?reply|donotreply|noreply-.*|notifications?|notify|alerts?|updates?|news(letter)?s?|marketing|mailer(-daemon)?|bounces?|postmaster|system|automated|auto|billing|invoices?|receipts?|orders?|shipping|delivery|tracking|accounts?|security|statements?|bot)([+._-].*)?$/i;

/** Categories that come from bulk-mail headers: a list sent it, not a person. */
const BULK_CATEGORIES: ReadonlySet<MailCategory> = new Set(['newsletter', 'promotion']);
/**
 * Categories a subject keyword or a sender name can produce. A customer whose
 * subject says "Invoice" is still a person, so these only count against an
 * address that does not look like someone's own.
 */
const SYSTEM_CATEGORIES: ReadonlySet<MailCategory> = new Set(['notification', 'receipt']);

export type CounterpartKind = 'person' | 'company';

export interface CounterpartEvidence {
	/** The owner's remembered "Recategorize as…" choice for this sender. */
	override?: MailCategory;
	/** The owner wrote to this address at least once (`mailContacts.useCount`). */
	isKnownCorrespondent: boolean;
	/** Categories of the threads this address sent the newest inbound message of. */
	categories: readonly MailCategory[];
	/** The display name the address writes under, when known. */
	name?: string;
}

/** The part before the last `@`, lowercased. */
function localPartOf(email: string): string {
	const at = email.lastIndexOf('@');
	return (at < 0 ? email : email.slice(0, at)).toLowerCase();
}

/** The part after the last `@`, lowercased, or '' for an address without one. */
export function domainOf(email: string): string {
	const at = email.lastIndexOf('@');
	return at < 0 ? '' : email.slice(at + 1).toLowerCase();
}

// The local parts only a machine writes from. A department address (billing,
// invoices, accounts, security) is not among them: a person may answer from it, so it
// counts as automated only once its mail says so (see isAutomatedAccount).
const SYSTEM_LOCAL_PART =
	/^(no-?reply|do-?not-?reply|donotreply|noreply-.*|notifications?|notify|alerts?|updates?|news(letter)?s?|marketing|mailer(-daemon)?|bounces?|postmaster|system|automated|auto|receipts?|orders?|shipping|delivery|tracking|statements?|bot)([+._-].*)?$/i;

/**
 * A company account that is a machine: it sends bulk or system mail (a
 * newsletter, a receipt), or writes from a no-reply style address. A
 * department address without either is a team you correspond with.
 */
export function isAutomatedAccount(email: string, kind: MailCategory | null): boolean {
	return kind !== null || SYSTEM_LOCAL_PART.test(localPartOf(email));
}

/** True for a department or system local part (no-reply, billing, …). */
export function isRoleAddress(email: string): boolean {
	return ROLE_LOCAL_PART.test(localPartOf(email));
}

/** Lowercased letters only, accents dropped: "Marín" → "marin". */
function foldLetters(text: string): string {
	return text
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z]/g, '');
}

/**
 * The address looks like someone's own: "first.last", or it holds the first
 * or last name the sender writes under ("ben@acme" from "Ben Ortiz").
 */
export function looksPersonal(email: string, name?: string): boolean {
	const local = localPartOf(email).replace(/\+.*$/, '');
	if (isRoleAddress(email)) return false;
	if (/^[a-z]{2,}[._-][a-z]{2,}$/i.test(local)) return true;
	const folded = foldLetters(local);
	const words = (name ?? '')
		.split(/\s+/)
		.map(foldLetters)
		.filter((w) => w.length >= 2);
	return words.length >= 2 && words.some((w) => folded.includes(w));
}

/**
 * Person or company account, first strong signal wins: the owner's own label,
 * then having written to the address, then a role local part, then what its
 * mail was classified as. Anything else is a person: calling a human a
 * machine hides them, the other mistake only costs a row in the wrong group.
 */
export function counterpartKind(email: string, evidence: CounterpartEvidence): CounterpartKind {
	if (evidence.override) return evidence.override === 'person' ? 'person' : 'company';
	if (evidence.isKnownCorrespondent) return 'person';
	if (isRoleAddress(email)) return 'company';
	const isPersonal = looksPersonal(email, evidence.name);
	let company = 0;
	let person = 0;
	for (const label of evidence.categories) {
		if (label === 'person') person += 1;
		else if (BULK_CATEGORIES.has(label)) company += 1;
		else if (SYSTEM_CATEGORIES.has(label) && !isPersonal) company += 1;
	}
	return company > person ? 'company' : 'person';
}

/**
 * The company an address belongs to: its organisational domain, or null on a
 * freemail domain (a gmail.com address is a person, not Google).
 */
export function companyKeyOf(email: string): string | null {
	const domain = domainOf(email);
	if (!domain || isFreemailDomain(domain)) return null;
	const org = organizationalDomain(domain) ?? domain;
	return isFreemailDomain(org) ? null : org;
}

/** The thread's other parties: participants minus the mailbox's own addresses. */
export function counterpartsOf(
	participants: readonly string[],
	ownAddresses: ReadonlySet<string>
): string[] {
	const seen = new Set<string>();
	for (const raw of participants) {
		const email = normalizeEmail(extractEmail(raw));
		if (!email.includes('@') || ownAddresses.has(email)) continue;
		seen.add(email);
	}
	return [...seen];
}

/** "lena.hartmann" → "Lena Hartmann": a readable name when no display name is known. */
export function nameFromAddress(email: string): string {
	const words = localPartOf(email)
		.replace(/\+.*$/, '')
		.split(/[._-]+/)
		.filter((w) => w.length > 0 && !/^\d+$/.test(w));
	if (words.length === 0) return email;
	return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** "lumen-studio.example" → "Lumen Studio": a readable company name from its domain. */
export function nameFromDomain(domain: string): string {
	const label = domain.split('.')[0] ?? domain;
	const words = label.split('-').filter((w) => w.length > 0);
	if (words.length === 0) return domain;
	return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * A company's name from what one of its system senders calls itself: the
 * leading words that spell its domain ("Lumen Studio Billing" on
 * lumenstudio.example → "Lumen Studio"), else the whole name. Null when the
 * name has nothing to do with the domain.
 */
export function companyNameFromSender(name: string, domain: string | null): string | null {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return null;
	if (!domain) return words.join(' ');
	const label = foldLetters(domain.split('.')[0] ?? '');
	if (!label) return words.join(' ');
	let spelled = '';
	for (let i = 0; i < words.length; i++) {
		spelled += foldLetters(words[i]!);
		if (spelled === label) return words.slice(0, i + 1).join(' ');
		if (!label.startsWith(spelled)) break;
	}
	return foldLetters(words.join('')).includes(label) ? words.join(' ') : null;
}

/** Reply and forward prefixes, in the languages Owlat ships and the common clients. */
const SUBJECT_PREFIX = /^\s*((re|aw|sv|antw|wg|fw|fwd|tr|rv|vs)(\[\d+\])?\s*[:：]\s*)+/i;

/** The subject without its reply and forward prefixes; the title before a model writes one. */
export function cleanSubject(subject: string): string {
	const cleaned = subject.replace(SUBJECT_PREFIX, '').trim();
	return cleaned.length > 0 ? cleaned : subject.trim();
}

/**
 * `you`: an answer is owed (the Answer queue holds it). `them`: something was
 * asked of the other side (an open item of theirs, a follow-up watch).
 * `replied`: the owner wrote last and nothing is owed back, which is not
 * waiting: a closing "thanks" expects no answer. `none`: none of these.
 */
export type TopicTurn = 'you' | 'them' | 'replied' | 'none';

export interface TurnInput {
	/** In the Answer queue: the same flag the Answer queue and Workbench count. */
	isOwedByUs: boolean;
	/** The brief has open items owed by the other side, or a follow-up watch is armed. */
	isOwedToUs: boolean;
	/** The owner wrote the newest message. */
	isLatestFromOwner: boolean;
}

const REQUEST_PHRASE =
	/\b(could|can|would|will) you\b|\bplease\b|\blet me know\b|\bkindly\b|\bneed (you|your)\b|\bbitte\b|\b(kannst|könntest|würdest) du\b|\b(können|könnten|würden) sie\b|\b(gib|gebt|sag) (mir |uns )?bescheid\b/i;

/**
 * Do the latest words ask something of the reader: a question, or a request
 * phrase in English or German. Only a heuristic Answer-queue flag is held to
 * it: without a model, that flag catches every personal message, and "thanks
 * again" is not a reply owed.
 */
export function asksSomething(text: string): boolean {
	return text.includes('?') || REQUEST_PHRASE.test(text);
}

/** Whose turn the conversation is. Owing an answer outranks waiting for one. */
export function topicTurn(input: TurnInput): TopicTurn {
	if (input.isOwedByUs) return 'you';
	if (input.isOwedToUs) return 'them';
	return input.isLatestFromOwner ? 'replied' : 'none';
}

/**
 * Current: neither archived nor muted. Archiving or muting is the owner saying
 * a conversation is done here; nothing leaves Current by age, since an
 * unanswered request does not stop mattering because it waited.
 */
export function isCurrentTopic(input: { isArchived: boolean; isMuted: boolean }): boolean {
	return !input.isArchived && !input.isMuted;
}

/** Archived: in Archive and no longer in the Inbox. */
export function isArchivedThread(folderRoles: readonly string[]): boolean {
	return folderRoles.includes('archive') && !folderRoles.includes('inbox');
}

/**
 * What a system sender sends, when its mail's category undersells it: a
 * newsletter's address names itself even when the subject read like a notice.
 */
export function accountKindOf(email: string, kind: MailCategory | null): MailCategory | null {
	return /^news(letter)?s?([+._-].*)?$/i.test(localPartOf(email)) ? 'newsletter' : kind;
}

/** The thread lives only in Trash, Spam or Drafts: not part of anyone's conversations. */
export function isOutOfView(folderRoles: readonly string[]): boolean {
	if (folderRoles.length === 0) return false;
	return folderRoles.every((role) => role === 'trash' || role === 'spam' || role === 'drafts');
}
