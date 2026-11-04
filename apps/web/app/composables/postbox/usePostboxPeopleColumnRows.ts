/**
 * The People column's rows: who goes in which group and in what order, what
 * each row says, and the search results. Apart from the column component so
 * the grouping reads in one place; the component keeps the chrome and keys.
 */
import type { ComputedRef, Ref } from 'vue';
import {
	askingSentence,
	askWithContext,
	dueOf,
	dueParts,
	isListedCompany,
	leadTopic,
	normalize,
	searchTerms,
	type PeopleCompany,
	type PeopleDirectory,
	type PeoplePerson,
	type PeopleSections,
	type PeopleSelection,
	type PeopleTopic,
} from '~/utils/postboxPeople';

export interface PeopleColumnSource {
	directory: PeopleDirectory | null;
	topics: ReadonlyMap<string, PeopleTopic>;
	companies: ReadonlyMap<string, PeopleCompany>;
	people: ReadonlyMap<string, PeoplePerson>;
	selection: PeopleSelection | null;
	pageHref: (target: PeopleSelection) => string;
	topicHref: (topic: PeopleTopic, from: PeopleSelection | null) => string;
}

export function usePostboxPeopleColumnRows(args: {
	props: PeopleColumnSource;
	query: Ref<string>;
	sections: ComputedRef<PeopleSections>;
	isShared: ComputedRef<boolean>;
	isSearching: ComputedRef<boolean>;
}) {
	const { props, sections, isShared, isSearching } = args;
	const { t, locale } = useI18n();
	/** "Due Nov 8" for the request a row leads with, when it has a date. */
	const isPast = (at: number | undefined) =>
		at !== undefined && dueParts(at, locale.value).isOverdue;
	function dueLabel(at: number | undefined): string | undefined {
		if (at === undefined) return undefined;
		const { date, isOverdue } = dueParts(at, locale.value);
		return isOverdue
			? t('components.postbox.people.row.overdueOn', { date })
			: t('components.postbox.people.row.dueOn', { date });
	}

	const terms = computed(() => searchTerms(args.query.value));
	/**
	 * A row found through one of its topics is a search result for that topic:
	 * it opens the conversation and shows its own date and mark, with the person
	 * as context; the person-wide counts would describe other conversations.
	 */
	function topicResult(topic: PeopleTopic, from: PeopleSelection) {
		return {
			to: props.topicHref(topic, from),
			topic: topic.title,
			highlight: terms.value,
			moreTopics: 0,
			lastAt: topic.lastMessageAt,
			unread: topic.unreadCount,
			owed: topic.isAsk ? 1 : 0,
			mayOwe: topic.turn === 'you' && !topic.isAsk ? 1 : 0,
			due: dueLabel(dueOf(topic)),
			isOverdue: isPast(dueOf(topic)),
		};
	}

	function personRow(person: PeoplePerson) {
		const lead = leadTopic(person.topicIds, props.topics);
		const company = person.companyKey ? props.companies.get(person.companyKey) : undefined;
		return {
			colorKey: person.key,
			name: person.name,
			tag:
				company && company.personKeys.length + company.accountKeys.length > 1
					? company.name
					: undefined,
			to: props.pageHref({ kind: 'person', key: person.key }),
			isActive: props.selection?.kind === 'person' && props.selection.key === person.key,
			topic: lead?.title,
			moreTopics: Math.max(0, person.currentCount - (lead?.isCurrent ? 1 : 0)),
			unread: person.unread,
			owed: person.owedCount,
			mayOwe: person.mayOweCount,
			due: dueLabel(dueOf(lead)),
			isOverdue: isPast(dueOf(lead)),
			lastAt: person.lastAt,
		};
	}

	// Two lists: the companies you correspond with (a group of people, or a
	// department such as billing@ that people answer from), and the senders that
	// are nothing but a company's machines.
	// Senders with nothing new fold away like "Quiet lately".
	const showAllSenders = ref(false);
	const peopleCompanies = computed(() =>
		sections.value.companies.filter((company) => !company.isAutomated)
	);
	const senders = computed(() => sections.value.companies.filter((company) => company.isAutomated));
	const isLiveSender = (company: PeopleCompany) =>
		company.unread > 0 || company.topicIds.some((id) => props.topics.get(id)?.openItem?.isOurs);
	const shownSenders = computed(() =>
		showAllSenders.value || isSearching.value ? senders.value : senders.value.filter(isLiveSender)
	);
	const foldedSenders = computed(() => senders.value.length - shownSenders.value.length);

	function companyRow(company: PeopleCompany) {
		const lead = leadTopic(company.topicIds, props.topics);
		// A sender's row only says when its mail asks something by a date.
		const own = company.topicIds
			.map((id) => props.topics.get(id))
			.filter((x): x is PeopleTopic => !!x);
		const members = new Set(company.personKeys);
		const departmentOwn = own.filter((x) => !x.partyKeys.some((k) => members.has(k)));
		const departmentOwed = departmentOwn.filter((x) => x.isAsk).length;
		const departmentMayOwe = departmentOwn.filter((x) => x.turn === 'you' && !x.isAsk).length;
		const peopleOwed = own.filter((x) => x.isAsk && x.partyKeys.some((k) => members.has(k))).length;
		const peopleMayOwe = own.filter(
			(x) => x.turn === 'you' && !x.isAsk && x.partyKeys.some((k) => members.has(k))
		).length;
		// The row's mark and its summary come from one set: what its people and
		// departments wait on together, never a bare unread dot beside it.
		const owed = company.isAutomated ? 0 : departmentOwed + peopleOwed;
		const mayOwe = company.isAutomated || owed > 0 ? 0 : departmentMayOwe + peopleMayOwe;
		const peopleState =
			owed > 0
				? t('components.postbox.people.row.companyOwed', { count: owed }, owed)
				: mayOwe > 0
					? t('components.postbox.people.row.companyMayOwe', { count: mayOwe }, mayOwe)
					: '';
		const dueAt = company.isAutomated
			? own.find((x) => x.openItem?.isOurs && x.openItem.dueAt !== undefined)?.openItem?.dueAt
			: dueOf(lead);
		// The summary names whoever its count is about (a department by its
		// address, "billing@"); all the people otherwise.
		const counted = (x: PeopleTopic) => (owed > 0 ? x.isAsk : x.turn === 'you' && !x.isAsk);
		const countedTopics = own.filter(counted);
		const flagged = company.personKeys.filter((key) =>
			countedTopics.some((x) => x.partyKeys.includes(key))
		);
		const departments = company.accountKeys.filter((key) =>
			countedTopics.some((x) => x.partyKeys.includes(key))
		);
		const people = [
			...(flagged.length > 0 || departments.length > 0 ? flagged : company.personKeys).map(
				(key) => props.people.get(key)?.name.split(' ')[0] ?? key
			),
			...departments.map((key) => `${key.split('@')[0]}@`),
		];
		return {
			name: company.name,
			// A company of people is named by its people; a sender by what it sends.
			tag: !company.isAutomated
				? undefined
				: t(`components.postbox.people.kind.${company.kind ?? 'other'}`),
			to: props.pageHref({ kind: 'company', key: company.key }),
			isActive: props.selection?.kind === 'company' && props.selection.key === company.key,
			topic:
				company.personKeys.length > 0
					? [peopleState, people.join(', ')].filter(Boolean).join(' · ')
					: lead?.title,
			owed,
			mayOwe,
			unread: departmentOwn.reduce((sum, x) => sum + x.unreadCount, 0),
			due: dueLabel(dueAt),
			isOverdue: isPast(dueAt),
			lastAt: company.lastAt,
			logoUrl: company.logoUrl,
			isAutomated: company.isAutomated,
			senderKind: company.kind,
		};
	}

	// What a company's own accounts ask of you (a billing department's question,
	// a payment due): a company row joins "Waiting on you" with the request, so
	// it is not left below every person. Its people's conversations stay theirs.
	function companyAsks(company: PeopleCompany): PeopleTopic[] {
		const people = new Set(company.personKeys);
		return company.topicIds
			.map((id) => props.topics.get(id))
			.filter(
				(x): x is PeopleTopic =>
					!!x &&
					!x.isArchived &&
					x.openItem?.isOurs === true &&
					!x.partyKeys.some((k) => people.has(k))
			);
	}
	function companyAskRow(company: PeopleCompany, asks: PeopleTopic[]) {
		// The most pressing of its requests leads; the mark counts them all.
		const ask = [...asks].sort(
			(x, y) =>
				(x.openItem?.dueAt ?? Number.POSITIVE_INFINITY) -
					(y.openItem?.dueAt ?? Number.POSITIVE_INFINITY) || y.lastMessageAt - x.lastMessageAt
		)[0]!;
		const text = locale.value === 'de' ? ask.openItem!.text.de : ask.openItem!.text.en;
		return {
			row: {
				...companyRow(company),
				moreTopics: 0,
				to: props.topicHref(ask, { kind: 'company' as const, key: company.key }),
				topic: text,
				owed: asks.length,
				mayOwe: 0,
				due: dueLabel(ask.openItem!.dueAt),
				isOverdue: isPast(ask.openItem!.dueAt),
				lastAt: ask.lastMessageAt,
			},
			dueAt: ask.openItem!.dueAt,
		};
	}

	/**
	 * A search is a lookup, not a triage split: who matched by name, then each
	 * conversation whose title matched, once, opening that conversation with
	 * whoever it is with as context.
	 */
	const searchGroups = computed(() => {
		if (!props.directory) return [];
		const q = terms.value;
		const hit = (text: string) => q.every((term) => normalize(text).includes(term));
		const entities: ColumnRow[] = [
			...props.directory.people
				.filter((p) => hit(`${p.name} ${p.email}`))
				.map((p): ColumnRow => ({ kind: 'person', ...personRow(p), highlight: terms.value })),
			...props.directory.companies
				.filter((c) => isListedCompany(c) && hit(`${c.name} ${c.domain ?? ''}`))
				.map((c): ColumnRow => ({
					kind: 'company',
					moreTopics: 0,
					...companyRow(c),
					highlight: terms.value,
				})),
		];
		const companyOfAccount = new Map(
			props.directory.companies.flatMap((c) => c.accountKeys.map((k) => [k, c] as const))
		);
		const conversations = props.directory.topics
			// The name Owlat gave it or the subject it was written under: a renamed
			// conversation is still found by the words its mail used.
			.filter((topic) => hit(`${topic.title} ${topic.subject}`))
			.flatMap((topic): ColumnRow[] => {
				const personKey = topic.partyKeys.find((k) => props.people.has(k));
				const person = personKey ? props.people.get(personKey) : undefined;
				const company = person
					? undefined
					: topic.partyKeys.map((k) => companyOfAccount.get(k)).find(Boolean);
				// Conversation first: its title is the row's name, whoever it is with
				// the line beneath.
				const asConversation = (row: ColumnRow, from: PeopleSelection, who: string): ColumnRow => ({
					...row,
					...topicResult(topic, from),
					avatarName: row.name,
					isActive: false,
					name: topic.title,
					tag: undefined,
					topic: t('components.postbox.people.column.withWhom', { name: who }),
				});
				if (person) {
					const company = person.companyKey ? props.companies.get(person.companyKey) : undefined;
					const who =
						company && isListedCompany(company) ? `${person.name} · ${company.name}` : person.name;
					return [
						asConversation(
							{ kind: 'person', ...personRow(person) },
							{ kind: 'person', key: person.key },
							who
						),
					];
				}
				if (company)
					return [
						asConversation(
							{ kind: 'company', moreTopics: 0, ...companyRow(company) },
							{ kind: 'company', key: company.key },
							company.name
						),
					];
				return [];
			})
			.sort((x, y) => y.lastAt - x.lastAt);
		return [
			{ id: 'results', title: t('components.postbox.people.column.peopleResults'), rows: entities },
			{
				id: 'conversations',
				title: t('components.postbox.people.column.conversationResults'),
				rows: conversations,
			},
		].filter((g) => g.rows.length > 0);
	});

	// "May need a reply" and "Recent" can hold everyone in a busy mailbox: the
	// first few, then one row that opens the rest, so Companies stay in reach.
	const GROUP_CAP = 8;
	const expandedGroups = ref(new Set<string>());
	/** The first rows of a long group, how many wait behind them, and whether it can fold back. */
	function capped<T>(
		id: string,
		list: readonly T[]
	): { rows: T[]; hidden: number; canCollapse: boolean } {
		if (expandedGroups.value.has(id))
			return { rows: [...list], hidden: 0, canCollapse: list.length > GROUP_CAP };
		return {
			rows: list.slice(0, GROUP_CAP),
			hidden: Math.max(0, list.length - GROUP_CAP),
			canCollapse: false,
		};
	}
	function expandGroup(id: string) {
		expandedGroups.value = new Set([...expandedGroups.value, id]);
	}
	function collapseGroup(id: string) {
		expandedGroups.value = new Set([...expandedGroups.value].filter((x) => x !== id));
	}
	// Props for one PostboxPeopleRow, a person's or a company's.
	interface ColumnRow {
		kind: 'person' | 'company';
		name: string;
		to: string;
		isActive: boolean;
		lastAt: number;
		moreTopics: number;
		unread: number;
		owed: number;
		mayOwe?: number | undefined;
		colorKey?: string | undefined;
		logoUrl?: string | undefined;
		isAutomated?: boolean | undefined;
		senderKind?: string | null | undefined;
		tag?: string | undefined;
		topic?: string | undefined;
		due?: string | undefined;
		highlight?: readonly string[] | undefined;
		avatarName?: string | undefined;
		isOverdue?: boolean | undefined;
	}
	const personGroups = computed<
		Array<{
			id: string;
			title: string;
			rows: ColumnRow[];
			hidden?: number;
			canCollapse?: boolean;
		}>
	>(() => {
		const asPerson = (p: PeoplePerson): ColumnRow => ({ kind: 'person', ...personRow(p) });
		// A waiting row leads with what is asked when Owlat read it, not the topic.
		const withRequest = (p: PeoplePerson, row: ColumnRow): ColumnRow => {
			const item = leadTopic(p.topicIds, props.topics)?.openItem;
			if (!item?.isOurs) return row;
			return { ...row, topic: locale.value === 'de' ? item.text.de : item.text.en };
		};
		if (isSearching.value) return searchGroups.value;
		// People and companies waiting on you share one order: soonest due first,
		// then the most recent, so a payment due today never sits below everyone.
		const soonest = (p: PeoplePerson) =>
			Math.min(...p.topicIds.map((id) => dueOf(props.topics.get(id)) ?? Number.POSITIVE_INFINITY));
		const waiting = [
			...sections.value.waiting.map((p) => ({
				row: withRequest(p, asPerson(p)),
				dueAt: soonest(p),
			})),
			...sections.value.companies.flatMap((c) => {
				const asks = companyAsks(c);
				if (asks.length === 0) return [];
				const { row, dueAt } = companyAskRow(c, asks);
				return [
					{ row: { kind: 'company' as const, ...row }, dueAt: dueAt ?? Number.POSITIVE_INFINITY },
				];
			}),
		]
			.sort((x, y) => x.dueAt - y.dueAt || y.row.lastAt - x.row.lastAt)
			.map((x) => x.row);
		return [
			{
				id: 'waiting',
				title: isShared.value
					? t('components.postbox.people.column.waitingTeam')
					: t('components.postbox.people.column.waiting'),
				...capped('waiting', waiting),
			},
			(() => {
				// A question from a department address (billing@) is as much a maybe
				// as a person's: it joins them with its asking sentence.
				const companyMaybes = sections.value.companies.flatMap((c): ColumnRow[] => {
					if (c.isAutomated) return [];
					const members = new Set(c.personKeys);
					const ask = c.topicIds
						.map((id) => props.topics.get(id))
						.find(
							(x) =>
								!!x &&
								x.turn === 'you' &&
								!x.isAsk &&
								!x.isArchived &&
								!x.partyKeys.some((k) => members.has(k))
						);
					if (!ask) return [];
					return [
						{
							kind: 'company',
							moreTopics: 0,
							...companyRow(c),
							to: props.topicHref(ask, { kind: 'company', key: c.key }),
							topic: (() => {
								const sentence = askingSentence(ask.snippet);
								return sentence ? askWithContext(sentence, ask.title) : ask.title;
							})(),
							owed: 0,
							mayOwe: 1,
							lastAt: ask.lastMessageAt,
						},
					];
				});
				const all = [
					...sections.value.maybe.map((p) => {
						const row = asPerson(p);
						const lead = leadTopic(p.topicIds, props.topics);
						const sentence = lead ? askingSentence(lead.snippet) : null;
						const ask = sentence && lead ? askWithContext(sentence, lead.title) : null;
						// Without a model the ring alone says little: the row shows the
						// sentence that asks, not only the topic.
						return ask ? { ...row, topic: ask } : row;
					}),
					...companyMaybes,
				].sort((x, y) => y.lastAt - x.lastAt);
				const { rows, hidden, canCollapse } = capped('maybe', all);
				return {
					id: 'maybe',
					title: t('components.postbox.people.column.maybe'),
					rows,
					hidden,
					canCollapse,
				};
			})(),
			(() => {
				const { rows, hidden, canCollapse } = capped('active', sections.value.active);
				return {
					id: 'active',
					title: t('components.postbox.people.column.active'),
					rows: rows.map(asPerson),
					hidden,
					canCollapse,
				};
			})(),
		].filter((g) => g.rows.length > 0);
	});

	// Every conversation the "May need a reply" group stands for, for its
	// "None of these need a reply".
	const maybeTopics = computed(() =>
		[...props.topics.values()].filter(
			(x) => x.turn === 'you' && !x.isAsk && x.isCurrent && !x.isArchived
		)
	);

	return {
		terms,
		maybeTopics,
		peopleCompanies,
		senders,
		shownSenders,
		foldedSenders,
		showAllSenders,
		personRow,
		companyRow,
		searchGroups,
		personGroups,
		expandGroup,
		collapseGroup,
		capped,
	};
}
