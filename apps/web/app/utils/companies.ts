/**
 * Presentation helpers for companies: the people a workspace talks to, grouped
 * by the organisational domain of their addresses (`@owlat/shared/companyKey`).
 * Pure, so the wording and the links are tested without mounting a page.
 */

/** A message key and the values it is rendered with. */
export interface CompanyMessage {
	key: string;
	params: Record<string, string | number>;
	/** The plural choice, for keys with a `one | many` form. */
	plural?: number;
}

/**
 * "Taylor is also in touch with Northwind." The only thing a colleague's
 * personal mailbox may reveal is that the colleague talks to the company, so
 * the line names people and nothing else: no subject, no count of
 * conversations, no date.
 *
 * `names` are the colleagues the roster could name; `unnamed` counts the ids it
 * could not (a roster still loading, a member who left). Up to three people
 * are named; past that, two names and "N others".
 */
export function colleagueLine(
	names: readonly string[],
	unnamed: number,
	company: string,
	opts: { short?: boolean } = {}
): CompanyMessage | null {
	const total = names.length + unnamed;
	if (total === 0) return null;
	// The short form ("Taylor also in touch") is for a summary that already
	// names the company; it carries the same names and nothing more.
	const base = opts.short
		? 'components.companies.colleaguesShort'
		: 'components.companies.colleagues';
	if (names.length === 0) {
		return { key: `${base}.someone`, params: { company, count: total }, plural: total };
	}
	const shown = names.slice(0, total <= 3 ? 3 : 2);
	const rest = total - shown.length;
	const [first = '', second = '', third = ''] = shown;
	if (rest === 0) {
		if (shown.length === 1) return { key: `${base}.one`, params: { first, company } };
		if (shown.length === 2) return { key: `${base}.two`, params: { first, second, company } };
		return { key: `${base}.three`, params: { first, second, third, company } };
	}
	if (shown.length === 1) {
		return { key: `${base}.oneAndOthers`, params: { first, company, count: rest }, plural: rest };
	}
	return {
		key: `${base}.twoAndOthers`,
		params: { first, second, company, count: rest },
		plural: rest,
	};
}

/**
 * The open work beside a conversation: its own tasks first (done ones too, so
 * one ticked off here can be reopened), then the open tasks about its
 * companies that it does not already hold, open before done.
 */
export function mergeOpenWork<T extends { _id: string; status: string }>(
	threadTasks: readonly T[],
	companyTasks: readonly (readonly T[])[]
): T[] {
	const seen = new Set<string>();
	const all: T[] = [];
	for (const task of [...threadTasks, ...companyTasks.flat()]) {
		if (seen.has(task._id)) continue;
		seen.add(task._id);
		all.push(task);
	}
	return [...all.filter((t) => t.status === 'open'), ...all.filter((t) => t.status !== 'open')];
}

/** Companies whose name or domain contains every word of `query`, in their order. */
export function filterCompanies<T extends { key: string; name: string }>(
	companies: readonly T[],
	query: string
): T[] {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [...companies];
	return companies.filter((company) => {
		const haystack = `${company.name} ${company.key}`.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}

export interface CompanyConversationRef {
	kind: 'mail' | 'team';
	messageId?: string | null;
	mailboxId: string | null;
	conversationThreadId: string | null;
}

/**
 * Where a conversation opens: a Team Inbox thread by its id, a mail thread in
 * the Postbox reader by its newest message and mailbox. Null for a mail thread
 * whose newest message the index does not know yet; the row then is not a link.
 */
export function companyConversationHref(conversation: CompanyConversationRef): string | null {
	if (conversation.kind === 'team') {
		return conversation.conversationThreadId
			? `/dashboard/inbox/${conversation.conversationThreadId}`
			: null;
	}
	if (!conversation.messageId) return null;
	const mailbox = conversation.mailboxId ? `?mailbox=${conversation.mailboxId}` : '';
	return `/dashboard/postbox/inbox/${conversation.messageId}${mailbox}`;
}

/** The company page. The key is a domain, so it is safe in a path once encoded. */
export function companyHref(key: string): string {
	return `/dashboard/companies/${encodeURIComponent(key)}`;
}

/** What a person reads as: their recorded name, else the address. */
export function personLabel(person: { address: string; name: string | null }): string {
	return person.name?.trim() || person.address;
}

/** The task's audience as its badge reads: a message key, or a group's own name. */
export function taskAudienceLabel(task: {
	visibility: 'private' | 'everyone' | 'group';
	groupName: string | null;
}): { key: string } | { text: string } {
	const base = 'components.companies.tasks.audience';
	if (task.visibility === 'private') return { key: `${base}.private` };
	if (task.visibility === 'everyone') return { key: `${base}.everyone` };
	return task.groupName ? { text: task.groupName } : { key: `${base}.group` };
}

/**
 * The people of one conversation as a short label: the first `max` by name
 * (or address), and how many more there are.
 */
export function conversationPeople(
	addresses: readonly string[],
	people: readonly { address: string; name: string | null }[],
	max = 2
): { shown: string[]; more: number } {
	const names = new Map(people.map((person) => [person.address, personLabel(person)]));
	const shown = addresses.slice(0, max).map((address) => names.get(address) ?? address);
	return { shown, more: Math.max(0, addresses.length - shown.length) };
}
