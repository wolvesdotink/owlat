import { describe, expect, it } from 'vitest';
import {
	isListedCompany,
	leadTopic,
	askWithContext,
	askingSentence,
	mergeEarlier,
	dueParts,
	highlightParts,
	searchTerms,
	peopleSections,
	selectionFromQuery,
	splitTopics,
	stripGreeting,
	previewText,
	topicPeriods,
	type PeopleCompany,
	type PeopleDirectory,
	type PeoplePerson,
	type PeopleTopic,
} from '../postboxPeople';

const NOW = new Date(2026, 10, 4, 12).getTime();
const DAY = 24 * 60 * 60 * 1000;

function topic(id: string, overrides: Partial<PeopleTopic> = {}): PeopleTopic {
	return {
		id,
		title: `Topic ${id}`,
		titleSource: 'subject',
		subject: `Re: Topic ${id}`,
		snippet: '',
		latestFromKey: null,
		lastMessageAt: NOW - DAY,
		firstMessageAt: NOW - 2 * DAY,
		messageCount: 2,
		unreadCount: 0,
		hasAttachments: false,
		hasFlagged: false,
		turn: 'none',
		isAsk: false,
		isCurrent: true,
		isPinned: false,
		isMuted: false,
		isArchived: false,
		partyKeys: [],
		...overrides,
	};
}

function person(key: string, overrides: Partial<PeoplePerson> = {}): PeoplePerson {
	return {
		key,
		email: key,
		name: key.split('@')[0]!,
		companyKey: null,
		isVip: false,
		lastAt: NOW,
		unread: 0,
		owedCount: 0,
		mayOweCount: 0,
		currentCount: 0,
		topicIds: [],
		...overrides,
	};
}

function company(key: string, overrides: Partial<PeopleCompany> = {}): PeopleCompany {
	return {
		key,
		name: key,
		domain: key,
		kind: null,
		personKeys: [],
		accountKeys: [],
		lastAt: NOW,
		unread: 0,
		topicIds: [],
		...overrides,
	};
}

function directory(overrides: Partial<PeopleDirectory>): PeopleDirectory {
	return {
		scope: 'personal',
		mailboxAddress: 'me@owlat.example',
		isWindowFull: false,
		isOutstandingCapped: false,
		people: [],
		accounts: [],
		companies: [],
		topics: [],
		...overrides,
	};
}

describe('peopleSections', () => {
	const dir = directory({
		people: [
			person('lena@lumen.example', {
				name: 'Lena Hartmann',
				owedCount: 1,
				currentCount: 2,
				companyKey: 'lumen.example',
				topicIds: ['t1'],
			}),
			person('tom@lumen.example', { currentCount: 1, companyKey: 'lumen.example' }),
			person('sofia@marin.example', { mayOweCount: 1, currentCount: 1 }),
			person('jonas@gmail.com', { name: 'Jonas Weber', topicIds: ['t2'] }),
		],
		companies: [
			company('lumen.example', {
				name: 'Lumen Studio',
				personKeys: ['lena@lumen.example', 'tom@lumen.example'],
			}),
			company('solo.example', { personKeys: ['x@solo.example'] }),
		],
		topics: [
			topic('t1', { title: 'Contract renewal' }),
			topic('t2', { title: 'Weekend at the lake' }),
		],
	});

	it('splits people by whose turn it is and lists only real companies', () => {
		const sections = peopleSections(dir, '');
		expect(sections.waiting.map((p) => p.key)).toEqual(['lena@lumen.example']);
		expect(sections.maybe.map((p) => p.key)).toEqual(['sofia@marin.example']);
		expect(sections.active.map((p) => p.key)).toEqual(['tom@lumen.example']);
		expect(sections.quiet.map((p) => p.key)).toEqual(['jonas@gmail.com']);
		expect(sections.companies.map((c) => c.key)).toEqual(['lumen.example']);
	});

	it('searches names, companies and topic titles, ignoring case and accents', () => {
		const byTopic = peopleSections(dir, 'LAKE');
		expect(byTopic.quiet.map((p) => p.key)).toEqual(['jonas@gmail.com']);
		const byCompany = peopleSections(dir, 'lumen');
		expect([...byCompany.waiting, ...byCompany.active].map((p) => p.key)).toEqual([
			'lena@lumen.example',
			'tom@lumen.example',
		]);
		expect(byCompany.companies.map((c) => c.key)).toEqual(['lumen.example']);
	});
});

describe('isListedCompany', () => {
	it('lists a company with a system sender or two people', () => {
		expect(isListedCompany(company('a', { accountKeys: ['no-reply@a'] }))).toBe(true);
		expect(isListedCompany(company('a', { personKeys: ['x@a', 'y@a'] }))).toBe(true);
		expect(isListedCompany(company('a', { personKeys: ['x@a'] }))).toBe(false);
	});
});

describe('leadTopic and splitTopics', () => {
	const topics = new Map([
		['old', topic('old', { isCurrent: false, lastMessageAt: NOW - 40 * DAY })],
		['theirs', topic('theirs', { turn: 'them' })],
		['ours', topic('ours', { turn: 'you', lastMessageAt: NOW - 3 * DAY })],
	]);

	it('leads with a request to us, then whatever is our turn', () => {
		const withAsk = new Map([
			...topics,
			['ask', topic('ask', { turn: 'you', isAsk: true, lastMessageAt: NOW - 9 * DAY })],
		]);
		expect(leadTopic(['ours', 'ask'], withAsk)?.id).toBe('ask');
	});

	it('leads with what waits on us', () => {
		expect(leadTopic(['old', 'theirs', 'ours'], topics)?.id).toBe('ours');
		expect(leadTopic(['old', 'theirs'], topics)?.id).toBe('theirs');
		expect(leadTopic(['old'], topics)?.id).toBe('old');
	});

	it('puts dated requests first, soonest due, ahead of a newer turn without evidence', () => {
		const ask = (id: string, dueAt?: number) =>
			topic(id, {
				turn: 'you',
				isAsk: true,
				lastMessageAt: NOW - 5 * DAY,
				...(dueAt ? { openItem: { text: { en: id, de: id }, isOurs: true, dueAt } } : {}),
			});
		const split = splitTopics([
			topic('maybe', { turn: 'you', lastMessageAt: NOW }),
			ask('plain'),
			ask('later', NOW + 5 * DAY),
			ask('soon', NOW + DAY),
		]);
		expect(split.now.map((t) => t.id)).toEqual(['soon', 'later', 'plain', 'maybe']);
	});

	it('orders current topics ours first, then theirs, and puts the rest in Earlier', () => {
		const split = splitTopics([...topics.values()]);
		expect(split.now.map((t) => t.id)).toEqual(['ours', 'theirs']);
		expect(split.earlier.map((t) => t.id)).toEqual(['old']);
	});
});

describe('topicPeriods', () => {
	it('groups the past year by month and older topics by year', () => {
		const periods = topicPeriods(
			[
				topic('a', { lastMessageAt: new Date(2026, 9, 20).getTime() }),
				topic('b', { lastMessageAt: new Date(2026, 9, 2).getTime() }),
				topic('c', { lastMessageAt: new Date(2026, 3, 9).getTime() }),
				topic('d', { lastMessageAt: new Date(2024, 2, 1).getTime() }),
			],
			new Date(NOW),
			'en'
		);
		expect(periods.map((p) => [p.label, p.topics.map((t) => t.id)])).toEqual([
			['October 2026', ['a', 'b']],
			['April 2026', ['c']],
			['2024', ['d']],
		]);
	});
});

describe('selectionFromQuery', () => {
	it('reads a person or a company page from the URL', () => {
		expect(selectionFromQuery({ person: 'lena@lumen.example' })).toEqual({
			kind: 'person',
			key: 'lena@lumen.example',
		});
		expect(selectionFromQuery({ company: 'lumen.example' })).toEqual({
			kind: 'company',
			key: 'lumen.example',
		});
		expect(selectionFromQuery({ person: '' })).toBeNull();
	});
});

describe('stripGreeting', () => {
	it('drops a salutation so the preview starts with what was said', () => {
		expect(stripGreeting('Hi again, thanks for the quick look.')).toBe(
			'Thanks for the quick look.'
		);
		expect(stripGreeting('Hallo Mara, anbei der Vertrag.')).toBe('Anbei der Vertrag.');
		expect(stripGreeting('Hey, are you still up for Saturday?')).toBe(
			'Are you still up for Saturday?'
		);
	});

	it('leaves text without a greeting, and a greeting with nothing after it, alone', () => {
		expect(stripGreeting('Your parcel is out for delivery.')).toBe(
			'Your parcel is out for delivery.'
		);
		expect(stripGreeting('Hi Lena,')).toBe('Hi Lena,');
	});
});

describe('previewText', () => {
	it('drops the greeting and the writer’s sign-off', () => {
		expect(
			previewText(
				'Hi again, thanks for the quick look. Could you send it by Friday? Best, Lena',
				'Lena'
			)
		).toBe('Thanks for the quick look. Could you send it by Friday?');
		expect(previewText('Mornings are best for our team. Lena', 'Lena')).toBe(
			'Mornings are best for our team.'
		);
		expect(previewText('Anbei der Vertrag. Viele Grüße', undefined)).toBe('Anbei der Vertrag.');
	});

	it('keeps a sentence that only ends in somebody else’s name', () => {
		expect(previewText('The intro came from Priya', 'Lena')).toBe('The intro came from Priya');
	});
});

describe('highlightParts', () => {
	it('marks what the search matched, ignoring case and accents', () => {
		expect(highlightParts('Café Müller', searchTerms('mull'))).toEqual([
			{ text: 'Café ', isHit: false },
			{ text: 'Müll', isHit: true },
			{ text: 'er', isHit: false },
		]);
	});
});

describe('askingSentence', () => {
	it('finds the sentence that asks', () => {
		expect(
			askingSentence(
				'Hi again, thanks for the quick look. Could you send the signed copy back by Friday? Legal wants it.'
			)
		).toBe('Could you send the signed copy back by Friday?');
		expect(askingSentence('The site is live. Thanks again.')).toBeNull();
	});
});

describe('dueParts', () => {
	it('counts overdue in calendar days, so due today is not overdue yet', () => {
		const morning = new Date(2026, 10, 4, 8).getTime();
		const evening = new Date(2026, 10, 4, 20).getTime();
		expect(dueParts(morning, 'en', evening).isOverdue).toBe(false);
		expect(dueParts(new Date(2026, 10, 3, 23).getTime(), 'en', evening)).toEqual({
			date: 'Nov 3',
			isOverdue: true,
		});
	});
});

describe('askWithContext', () => {
	it('puts the topic in front of an ask that points elsewhere', () => {
		expect(askWithContext('Would that work for you?', 'Speaker slot')).toBe(
			'Speaker slot · Would that work for you?'
		);
		expect(
			askWithContext('Could you send the signed copy back by Friday?', 'Contract renewal')
		).toBe('Could you send the signed copy back by Friday?');
	});
});

describe('mergeEarlier', () => {
	it('keeps current conversations out of the older pages and sorts newest first', () => {
		const current = topic('now', { lastMessageAt: NOW });
		const earlier = topic('e', { lastMessageAt: NOW - 30 * DAY, isCurrent: false });
		const old = topic('o', { lastMessageAt: NOW - 90 * DAY, isCurrent: false });
		const merged = mergeEarlier([earlier], [current, old, earlier], ['now']);
		expect(merged.map((x) => x.id)).toEqual(['e', 'o']);
	});
});
