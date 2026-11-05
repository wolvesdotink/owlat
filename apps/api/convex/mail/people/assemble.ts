/**
 * The People directory, folded from a window of recent threads: the people
 * the mailbox is talking to, the company accounts that send it mail, the
 * companies both belong to, and one topic per thread.
 *
 * Pure, so the grouping is tested without a database; `directory.ts` loads
 * the inputs. Not a Convex function.
 */

import type { MailCategory } from '../category';
import {
	cleanSubject,
	companyKeyOf,
	counterpartKind,
	counterpartsOf,
	isCurrentTopic,
	nameFromAddress,
	nameFromDomain,
	companyNameFromSender,
	accountKindOf,
	asksSomething,
	isAutomatedAccount,
	topicTurn,
	type TopicTurn,
} from './classify';

type Localized = { en: string; de: string };

export interface ThreadInput {
	id: string;
	participants: readonly string[];
	latestFromAddress: string;
	latestSubject: string;
	latestSnippet: string;
	latestMessageId?: string;
	lastMessageAt: number;
	firstMessageAt: number;
	messageCount: number;
	unreadCount: number;
	hasAttachments: boolean;
	hasFlagged: boolean;
	category?: MailCategory;
	isPinned: boolean;
	isMuted: boolean;
	isArchived: boolean;
	/** Marked done in the conversation view since its latest message. */
	isDone?: boolean;
	isOwedByUs: boolean;
	/** The model read the flag as a request; a heuristic flag only may be one. */
	isAskDetected: boolean;
	/** "No reply needed" was said since the latest message: no request counts. */
	isDismissed?: boolean;
	isOwedToUs: boolean;
	/** Opened topic title, when one was written. */
	title?: { text: string; source: 'ai' | 'user' };
	/** The brief's top open item and its "Latest update" line, opened. */
	openItem?: { text: Localized; dueAt?: number; isOurs: boolean };
	latestLine?: Localized;
	/** The model's one line of what is asked (needsReply.askSummary), where it may be shown. */
	askSummary?: string;
	/** A reply was drafted for review (needsReply.draftSlot). */
	hasSuggestedReply?: boolean;
}

/** What the mailbox knows about one address, beyond its threads. */
export interface AddressInput {
	name?: string;
	organization?: string;
	override?: MailCategory;
	isKnownCorrespondent: boolean;
	isVip: boolean;
	logoUrl?: string;
}

export interface DirectoryTopic {
	id: string;
	title: string;
	titleSource: 'ai' | 'user' | 'subject';
	subject: string;
	snippet: string;
	latestMessageId?: string;
	latestFromKey: string | null;
	lastMessageAt: number;
	firstMessageAt: number;
	messageCount: number;
	unreadCount: number;
	hasAttachments: boolean;
	hasFlagged: boolean;
	turn: TopicTurn;
	/**
	 * The mailbox's turn on evidence: the model read a request, or the brief
	 * holds one for us. A turn without it (a heuristic flag) only may need a
	 * reply, and the view says so rather than claim it.
	 */
	isAsk: boolean;
	isCurrent: boolean;
	isPinned: boolean;
	isMuted: boolean;
	isArchived: boolean;
	/** Marked done since its latest message (as well as, or instead of, archived). */
	isDone: boolean;
	category?: MailCategory;
	/** Every other party's key (a person's or a company account's address). */
	partyKeys: string[];
	openItem?: { text: Localized; dueAt?: number; isOurs: boolean };
	latestLine?: Localized;
	/** What the latest message asks of the mailbox, in the model's words; only on its turn. */
	askSummary?: string;
	/** A reply waits for review; only on the mailbox's turn. */
	hasSuggestedReply?: boolean;
}

export interface DirectoryPerson {
	key: string;
	email: string;
	name: string;
	companyKey: string | null;
	isVip: boolean;
	lastAt: number;
	unread: number;
	/** Topics waiting on the mailbox, on evidence (`DirectoryTopic.isAsk`). */
	owedCount: number;
	/** Topics whose turn is the mailbox's without that evidence. */
	mayOweCount: number;
	currentCount: number;
	/** Newest first. */
	topicIds: string[];
}

export interface DirectoryAccount {
	key: string;
	email: string;
	name: string;
	companyKey: string;
	/** What it sends most: newsletter, notification, receipt, promotion. */
	kind: MailCategory | null;
	/** A machine (`isAutomatedAccount`); else a department people answer from. */
	isAutomated: boolean;
	logoUrl?: string;
	lastAt: number;
	unread: number;
	topicIds: string[];
}

export interface DirectoryCompany {
	key: string;
	name: string;
	domain: string | null;
	logoUrl?: string;
	kind: MailCategory | null;
	/** Nobody to talk to: no people and only automated accounts. */
	isAutomated: boolean;
	personKeys: string[];
	accountKeys: string[];
	lastAt: number;
	unread: number;
	topicIds: string[];
}

export interface Directory {
	people: DirectoryPerson[];
	accounts: DirectoryAccount[];
	companies: DirectoryCompany[];
	topics: DirectoryTopic[];
}

/** The category a set of threads mostly carries, ignoring `person` and `other`. */
function dominantKind(labels: readonly MailCategory[]): MailCategory | null {
	const counts = new Map<MailCategory, number>();
	for (const label of labels) {
		if (label === 'person' || label === 'other' || label === 'spam') continue;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	let best: MailCategory | null = null;
	let bestCount = 0;
	for (const [label, count] of counts) {
		if (count > bestCount) {
			best = label;
			bestCount = count;
		}
	}
	return best;
}

/** The name most of `names` agree on, else the first one. */
function commonName(names: readonly string[]): string | undefined {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	let best: string | undefined;
	let bestCount = 0;
	for (const [name, count] of counts) {
		if (count > bestCount) {
			best = name;
			bestCount = count;
		}
	}
	return best;
}

export function assembleDirectory(input: {
	threads: readonly ThreadInput[];
	ownAddresses: ReadonlySet<string>;
	addresses: ReadonlyMap<string, AddressInput>;
}): Directory {
	const { threads, ownAddresses, addresses } = input;
	const topics: DirectoryTopic[] = [];
	// Per address: its topics, and the categories of the threads it sent last.
	const byAddress = new Map<string, { topics: DirectoryTopic[]; categories: MailCategory[] }>();

	for (const thread of threads) {
		const partyKeys = counterpartsOf(thread.participants, ownAddresses);
		if (partyKeys.length === 0) continue;
		const latestFromKey = partyKeys.find((key) => key === thread.latestFromAddress.toLowerCase());
		const isLatestFromOwner = ownAddresses.has(thread.latestFromAddress.toLowerCase());
		// A request the brief holds for us is our turn as much as an Answer-queue
		// flag; a heuristic flag counts only when the latest words ask something.
		// An unanswered request does not stop mattering with age.
		const isFlagged =
			thread.isOwedByUs && (thread.isAskDetected || asksSomething(thread.latestSnippet));
		const isBriefAsk = thread.openItem?.isOurs === true && !thread.isDismissed;
		const turn = topicTurn({
			isOwedByUs: isFlagged || isBriefAsk,
			isOwedToUs: thread.isOwedToUs,
			isLatestFromOwner,
		});
		const topic: DirectoryTopic = {
			id: thread.id,
			title: thread.title?.text ?? cleanSubject(thread.latestSubject),
			titleSource: thread.title?.source ?? 'subject',
			subject: thread.latestSubject,
			snippet: thread.latestSnippet,
			...(thread.latestMessageId ? { latestMessageId: thread.latestMessageId } : {}),
			latestFromKey: latestFromKey ?? null,
			lastMessageAt: thread.lastMessageAt,
			firstMessageAt: thread.firstMessageAt,
			messageCount: thread.messageCount,
			unreadCount: thread.unreadCount,
			hasAttachments: thread.hasAttachments,
			hasFlagged: thread.hasFlagged,
			turn,
			isAsk: turn === 'you' && (thread.isAskDetected || isBriefAsk),
			isCurrent: isCurrentTopic(thread),
			isPinned: thread.isPinned,
			isMuted: thread.isMuted,
			isArchived: thread.isArchived,
			isDone: thread.isDone === true,
			...(thread.category ? { category: thread.category } : {}),
			partyKeys,
			// A dismissed request is gone from every surface (text, date, company
			// promotion); the brief keeps it, so undo brings it back.
			...(thread.openItem && !(thread.isDismissed && thread.openItem.isOurs)
				? { openItem: thread.openItem }
				: {}),
			...(thread.latestLine ? { latestLine: thread.latestLine } : {}),
			...(thread.askSummary && turn === 'you' ? { askSummary: thread.askSummary } : {}),
			...(thread.hasSuggestedReply && turn === 'you' ? { hasSuggestedReply: true } : {}),
		};
		topics.push(topic);
		for (const key of partyKeys) {
			const entry = byAddress.get(key) ?? { topics: [], categories: [] };
			entry.topics.push(topic);
			if (key === latestFromKey && thread.category) entry.categories.push(thread.category);
			byAddress.set(key, entry);
		}
	}

	const people: DirectoryPerson[] = [];
	const accounts: DirectoryAccount[] = [];
	const companies = new Map<
		string,
		DirectoryCompany & { names: string[]; organizations: string[]; kinds: MailCategory[] }
	>();
	const companyFor = (key: string, domain: string | null) => {
		let company = companies.get(key);
		if (!company) {
			company = {
				key,
				name: '',
				domain,
				kind: null,
				isAutomated: true,
				personKeys: [],
				accountKeys: [],
				lastAt: 0,
				unread: 0,
				topicIds: [],
				names: [],
				organizations: [],
				kinds: [],
			};
			companies.set(key, company);
		}
		return company;
	};

	for (const [key, entry] of byAddress) {
		const info = addresses.get(key);
		const kind = counterpartKind(key, {
			...(info?.override ? { override: info.override } : {}),
			...(info?.name ? { name: info.name } : {}),
			isKnownCorrespondent: info?.isKnownCorrespondent ?? false,
			categories: entry.categories,
		});
		const lastAt = Math.max(...entry.topics.map((t) => t.lastMessageAt));
		const unread = entry.topics.reduce((sum, t) => sum + t.unreadCount, 0);
		const topicIds = [...entry.topics]
			.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
			.map((t) => t.id);
		const domainKey = companyKeyOf(key);
		if (kind === 'person') {
			people.push({
				key,
				email: key,
				name: info?.name ?? nameFromAddress(key),
				companyKey: domainKey,
				isVip: info?.isVip ?? false,
				lastAt,
				unread,
				owedCount: entry.topics.filter((t) => t.isAsk).length,
				mayOweCount: entry.topics.filter((t) => t.turn === 'you' && !t.isAsk).length,
				currentCount: entry.topics.filter((t) => t.isCurrent).length,
				topicIds,
			});
			if (domainKey) {
				const company = companyFor(domainKey, domainKey);
				company.personKeys.push(key);
				company.isAutomated = false;
				if (info?.organization) company.organizations.push(info.organization);
			}
			continue;
		}
		// A company account on a freemail domain is its own company.
		const companyKey = domainKey ?? `address:${key}`;
		// The owner's own filing ("Treat as automated sender") outranks what the mail carried.
		const filed =
			info?.override && info.override !== 'person' && info.override !== 'other'
				? info.override
				: null;
		const accountKind = accountKindOf(key, filed ?? dominantKind(entry.categories));
		const isAutomated = isAutomatedAccount(key, accountKind);
		const name = info?.name ?? (domainKey ? nameFromDomain(domainKey) : nameFromAddress(key));
		accounts.push({
			key,
			email: key,
			name,
			companyKey,
			kind: accountKind,
			isAutomated,
			...(info?.logoUrl ? { logoUrl: info.logoUrl } : {}),
			lastAt,
			unread,
			topicIds,
		});
		const company = companyFor(companyKey, domainKey);
		company.accountKeys.push(key);
		if (!isAutomated) company.isAutomated = false;
		const senderName = info?.name ? companyNameFromSender(info.name, domainKey) : null;
		if (senderName) company.names.push(senderName);
		if (info?.organization) company.organizations.push(info.organization);
		if (info?.logoUrl && !company.logoUrl) company.logoUrl = info.logoUrl;
		company.kinds.push(...(accountKind ? [accountKind] : entry.categories));
	}

	const topicById = new Map(topics.map((t) => [t.id, t]));
	const out: DirectoryCompany[] = [];
	for (const company of companies.values()) {
		const ids = new Set<string>();
		for (const key of [...company.personKeys, ...company.accountKeys]) {
			for (const id of byAddress.get(key)?.topics.map((t) => t.id) ?? []) ids.add(id);
		}
		const own = [...ids]
			.map((id) => topicById.get(id))
			.filter((t): t is DirectoryTopic => t !== undefined)
			.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
		const { names, organizations, kinds, ...rest } = company;
		out.push({
			...rest,
			name:
				commonName(organizations) ??
				commonName(names) ??
				(company.domain ? nameFromDomain(company.domain) : company.key),
			kind: dominantKind(kinds),
			lastAt: own[0]?.lastMessageAt ?? 0,
			unread: own.reduce((sum, t) => sum + t.unreadCount, 0),
			topicIds: own.map((t) => t.id),
		});
	}

	return {
		people: people.sort((a, b) => b.lastAt - a.lastAt),
		accounts: accounts.sort((a, b) => b.lastAt - a.lastAt),
		companies: out.sort((a, b) => b.lastAt - a.lastAt),
		topics,
	};
}
