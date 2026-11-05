/**
 * The conversation-first inbox's pure model over the directory read
 * (`mail/people/directory.ts`): the pane's rows (people, companies with their
 * members nested, group conversations), the Updates feed, a page's
 * conversations, and the line and cue each conversation row shows.
 *
 * Recency orders every list. Whether something needs a reply is a word on a
 * conversation row ("Reply?"), never a reordering of the people.
 */

import {
	askingSentence,
	normalize,
	previewText,
	searchTerms,
	type PeopleAccount,
	type PeopleCompany,
	type PeopleDirectory,
	type PeoplePerson,
	type PeopleTopic,
} from './postboxPeople';

/** Who wrote a line: a counterpart's first name, or the mailbox itself (null). */
export interface TopicLine {
	author: string | null;
	text: string;
}

export interface MemberRow {
	kind: 'person' | 'account';
	key: string;
	name: string;
	logoUrl?: string;
	lastAt: number;
	isUnread: boolean;
	line: TopicLine | null;
}

export type PaneRow =
	| {
			kind: 'person';
			key: string;
			person: PeoplePerson;
			lastAt: number;
			isUnread: boolean;
			line: TopicLine | null;
	  }
	| {
			kind: 'company';
			key: string;
			company: PeopleCompany;
			lastAt: number;
			isUnread: boolean;
			line: TopicLine | null;
			members: MemberRow[];
	  }
	| {
			kind: 'group';
			key: string;
			topic: PeopleTopic;
			/** The people in it, the latest writer first. */
			members: PeoplePerson[];
			lastAt: number;
			isUnread: boolean;
			line: TopicLine | null;
	  };

export function firstName(name: string): string {
	return name.trim().split(/\s+/)[0] ?? name;
}

/** The lookups every derivation here needs, built once per directory. */
export interface DirectoryIndex {
	directory: PeopleDirectory;
	topics: ReadonlyMap<string, PeopleTopic>;
	people: ReadonlyMap<string, PeoplePerson>;
	accounts: ReadonlyMap<string, PeopleAccount>;
	companies: ReadonlyMap<string, PeopleCompany>;
}

export function indexDirectory(directory: PeopleDirectory): DirectoryIndex {
	return {
		directory,
		topics: new Map(directory.topics.map((t) => [t.id, t])),
		people: new Map(directory.people.map((p) => [p.key, p])),
		accounts: new Map(directory.accounts.map((a) => [a.key, a])),
		companies: new Map(directory.companies.map((c) => [c.key, c])),
	};
}

/** Departments: a company's accounts that people answer from (billing@ a person reads). */
export function departmentsOf(index: DirectoryIndex, company: PeopleCompany): PeopleAccount[] {
	return company.accountKeys
		.map((key) => index.accounts.get(key))
		.filter((a): a is PeopleAccount => !!a && !a.isAutomated);
}

/**
 * A company gets a row of its own once there is more than one way to reach it:
 * two people, or a department. One person at a company is listed as that
 * person, and freemail people never form one (the server gives them none).
 */
export function isCompanyRow(index: DirectoryIndex, company: PeopleCompany): boolean {
	if (company.isAutomated) return false;
	const departments = departmentsOf(index, company).length;
	return departments > 0 || company.personKeys.length >= 2;
}

/** Where a person is listed: their company's row, or a row of their own. */
function homeOf(index: DirectoryIndex, personKey: string): string {
	const companyKey = index.people.get(personKey)?.companyKey;
	const company = companyKey ? index.companies.get(companyKey) : undefined;
	return company && isCompanyRow(index, company) ? `company:${company.key}` : `person:${personKey}`;
}

/**
 * A group conversation: people from two places or more (two friends, a
 * colleague and a client). Colleagues of one listed company writing together
 * are that company's conversation.
 */
export function isGroupTopic(index: DirectoryIndex, topic: PeopleTopic): boolean {
	const homes = new Set(
		topic.partyKeys.filter((key) => index.people.has(key)).map((key) => homeOf(index, key))
	);
	return homes.size >= 2;
}

/** Machine mail: every other party is an automated account. */
export function isUpdateTopic(index: DirectoryIndex, topic: PeopleTopic): boolean {
	return (
		topic.partyKeys.length > 0 &&
		topic.partyKeys.every((key) => index.accounts.get(key)?.isAutomated === true)
	);
}

/** The display name of a counterpart key, first name for people. */
export function authorName(index: DirectoryIndex, key: string): string {
	const person = index.people.get(key);
	if (person) return firstName(person.name);
	return index.accounts.get(key)?.name ?? key;
}

/** The conversation's latest words with who wrote them, greeting and sign-off cut. */
export function topicLine(index: DirectoryIndex, topic: PeopleTopic): TopicLine {
	const author = topic.latestFromKey ? authorName(index, topic.latestFromKey) : null;
	return { author, text: previewText(topic.snippet, author ?? undefined) };
}

function newest(topics: readonly PeopleTopic[]): PeopleTopic | undefined {
	let best: PeopleTopic | undefined;
	for (const t of topics) if (!best || t.lastMessageAt > best.lastMessageAt) best = t;
	return best;
}

function topicsOf(index: DirectoryIndex, ids: readonly string[]): PeopleTopic[] {
	return ids.map((id) => index.topics.get(id)).filter((t): t is PeopleTopic => !!t);
}

/** The pane's rows, newest activity first, narrowed by `query` when there is one. */
export function paneRows(index: DirectoryIndex, query = ''): PaneRow[] {
	const terms = searchTerms(query);
	const matches = (...texts: string[]) => {
		if (terms.length === 0) return true;
		const haystack = normalize(texts.join(' '));
		return terms.every((term) => haystack.includes(term));
	};
	const conversational = (ids: readonly string[]) =>
		topicsOf(index, ids).filter((t) => !isUpdateTopic(index, t) && !isGroupTopic(index, t));
	const titles = (topics: readonly PeopleTopic[]) => topics.map((t) => t.title);

	const rows: PaneRow[] = [];
	const nested = new Set<string>();

	for (const company of index.directory.companies) {
		if (!isCompanyRow(index, company)) continue;
		const members: MemberRow[] = [];
		const all: PeopleTopic[] = [];
		const memberTexts: string[] = [];
		for (const key of company.personKeys) {
			const person = index.people.get(key);
			if (!person) continue;
			nested.add(key);
			const own = conversational(person.topicIds);
			const lead = newest(own) ?? newest(topicsOf(index, person.topicIds));
			if (!lead) continue;
			all.push(...own);
			memberTexts.push(person.name, person.email, ...titles(own));
			members.push({
				kind: 'person',
				key,
				name: person.name,
				lastAt: lead.lastMessageAt,
				isUnread: own.some((t) => t.unreadCount > 0),
				line: topicLine(index, lead),
			});
		}
		for (const account of departmentsOf(index, company)) {
			const own = conversational(account.topicIds);
			const lead = newest(own);
			if (!lead) continue;
			all.push(...own);
			memberTexts.push(account.name, account.email, ...titles(own));
			members.push({
				kind: 'account',
				key: account.key,
				name: account.name,
				...(account.logoUrl ? { logoUrl: account.logoUrl } : {}),
				lastAt: lead.lastMessageAt,
				isUnread: own.some((t) => t.unreadCount > 0),
				line: topicLine(index, lead),
			});
		}
		const lead = newest(all);
		if (!lead || !matches(company.name, company.domain ?? '', ...memberTexts)) continue;
		members.sort((a, b) => b.lastAt - a.lastAt);
		rows.push({
			kind: 'company',
			key: company.key,
			company,
			lastAt: lead.lastMessageAt,
			isUnread: all.some((t) => t.unreadCount > 0),
			line: topicLine(index, lead),
			members,
		});
	}

	for (const person of index.directory.people) {
		if (nested.has(person.key)) continue;
		const own = conversational(person.topicIds);
		const lead = newest(own);
		const company = person.companyKey ? index.companies.get(person.companyKey) : undefined;
		if (!lead || !matches(person.name, person.email, company?.name ?? '', ...titles(own))) continue;
		rows.push({
			kind: 'person',
			key: person.key,
			person,
			lastAt: lead.lastMessageAt,
			isUnread: own.some((t) => t.unreadCount > 0),
			line: topicLine(index, lead),
		});
	}

	// A group stays in the list while it is current; an archived one lives on
	// its people's pages, under Earlier.
	for (const topic of index.directory.topics) {
		if (!topic.isCurrent || !isGroupTopic(index, topic)) continue;
		const members = topic.partyKeys
			.map((key) => index.people.get(key))
			.filter((p): p is PeoplePerson => !!p)
			.sort(
				(a, b) => Number(b.key === topic.latestFromKey) - Number(a.key === topic.latestFromKey)
			);
		if (!matches(topic.title, ...members.flatMap((p) => [p.name, p.email]))) continue;
		rows.push({
			kind: 'group',
			key: topic.id,
			topic,
			members,
			lastAt: topic.lastMessageAt,
			isUnread: topic.unreadCount > 0,
			line: topicLine(index, topic),
		});
	}

	return rows.sort((a, b) => b.lastAt - a.lastAt);
}

/** "Priya, Jonas +1": the first two people of a group by first name, then how many more. */
export function groupName(members: readonly PeoplePerson[]): { names: string; more: number } {
	return {
		names: members
			.slice(0, 2)
			.map((p) => firstName(p.name))
			.join(', '),
		more: Math.max(0, members.length - 2),
	};
}

/** Machine mail, newest first; from one company only when `companyKey` is given. */
export function updateTopics(index: DirectoryIndex, companyKey?: string | null): PeopleTopic[] {
	return index.directory.topics
		.filter((t) => isUpdateTopic(index, t))
		.filter(
			(t) =>
				!companyKey || t.partyKeys.some((key) => index.accounts.get(key)?.companyKey === companyKey)
		)
		.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

export type DayBucket = 'today' | 'yesterday' | 'week' | 'month' | 'older';

/** Updates grouped the way people think back: today, yesterday, this week, then by month. */
export function dayGroups<T extends { lastMessageAt: number }>(
	items: readonly T[],
	now: number
): Array<{ key: string; bucket: DayBucket; at: number; items: T[] }> {
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	const today = start.getTime();
	const yesterday = today - 86_400_000;
	const week = today - 6 * 86_400_000;
	const groups: Array<{ key: string; bucket: DayBucket; at: number; items: T[] }> = [];
	for (const item of items) {
		const at = item.lastMessageAt;
		const date = new Date(at);
		const bucket: DayBucket =
			at >= today ? 'today' : at >= yesterday ? 'yesterday' : at >= week ? 'week' : 'month';
		const key = bucket === 'month' ? `${date.getFullYear()}-${date.getMonth()}` : bucket;
		const last = groups.at(-1);
		if (last?.key === key) last.items.push(item);
		else groups.push({ key, bucket, at, items: [item] });
	}
	return groups;
}

export type Focus = 'all' | 'reply' | 'waiting';

export function parseFocus(value: unknown): Focus {
	return value === 'reply' || value === 'waiting' ? value : 'all';
}

/** A page's conversations: current ones newest first, then the archived and muted ones. */
export function pageConversations(
	index: DirectoryIndex,
	ids: readonly string[],
	options: { focus: Focus; memberKey?: string | null }
): { current: PeopleTopic[]; earlier: PeopleTopic[]; counts: Record<Focus, number> } {
	const own = topicsOf(index, ids)
		.filter((t) => !isUpdateTopic(index, t))
		.filter((t) => !options.memberKey || t.partyKeys.includes(options.memberKey))
		.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
	const current = own.filter((t) => t.isCurrent);
	const counts: Record<Focus, number> = {
		all: current.length,
		reply: current.filter((t) => t.turn === 'you').length,
		waiting: current.filter((t) => t.turn === 'them').length,
	};
	const focused =
		options.focus === 'reply'
			? current.filter((t) => t.turn === 'you')
			: options.focus === 'waiting'
				? current.filter((t) => t.turn === 'them')
				: current;
	return {
		current: focused,
		earlier: options.focus === 'all' ? own.filter((t) => !t.isCurrent) : [],
		counts,
	};
}

/**
 * What a conversation row says under its topic. A request leads, in the
 * model's words when it read one, else the sentence that asks; otherwise the
 * latest words with their author.
 */
export type RowSaying =
	| { kind: 'ask'; author: string | null; text: string; dueAt?: number }
	| { kind: 'line'; line: TopicLine };

export function rowSaying(
	index: DirectoryIndex,
	topic: PeopleTopic,
	locale: 'en' | 'de'
): RowSaying {
	const author = topic.latestFromKey ? authorName(index, topic.latestFromKey) : null;
	const dueAt = topic.openItem?.isOurs ? topic.openItem.dueAt : undefined;
	const due = dueAt !== undefined ? { dueAt } : {};
	if (topic.turn === 'you') {
		if (topic.askSummary) return { kind: 'ask', author, text: topic.askSummary, ...due };
		if (topic.openItem?.isOurs)
			return { kind: 'ask', author, text: topic.openItem.text[locale], ...due };
		const asking = askingSentence(topic.snippet);
		if (asking) return { kind: 'ask', author, text: asking, ...due };
	}
	return { kind: 'line', line: topicLine(index, topic) };
}

/** A due date's urgency: solid only when it is today or past. */
export function dueUrgency(at: number, now: number): 'due' | 'soon' {
	const end = new Date(now);
	end.setHours(23, 59, 59, 999);
	return at <= end.getTime() ? 'due' : 'soon';
}

/**
 * Who may need a reply, for the pane's greeting: the people whose current
 * conversations end in a request, most recent first.
 */
export function replyNames(index: DirectoryIndex): PeoplePerson[] {
	const latest = new Map<string, number>();
	for (const topic of index.directory.topics) {
		if (!topic.isCurrent || topic.turn !== 'you' || !topic.latestFromKey) continue;
		if (!index.people.has(topic.latestFromKey)) continue;
		latest.set(
			topic.latestFromKey,
			Math.max(latest.get(topic.latestFromKey) ?? 0, topic.lastMessageAt)
		);
	}
	return [...latest.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([key]) => index.people.get(key))
		.filter((p): p is PeoplePerson => !!p);
}
