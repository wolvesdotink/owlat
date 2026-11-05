import { describe, expect, it } from 'vitest';
import {
	dayGroups,
	dueUrgency,
	groupName,
	indexDirectory,
	isGroupTopic,
	pageConversations,
	paneRows,
	replyNames,
	rowSaying,
	updateTopics,
} from '../postboxConversations';
import type {
	PeopleAccount,
	PeopleCompany,
	PeopleDirectory,
	PeoplePerson,
	PeopleTopic,
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

function account(key: string, overrides: Partial<PeopleAccount> = {}): PeopleAccount {
	return {
		key,
		email: key,
		name: key.split('@')[0]!,
		companyKey: key.split('@')[1]!,
		kind: null,
		isAutomated: true,
		lastAt: NOW,
		unread: 0,
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
		isAutomated: false,
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

/** Lena and Tom at Lumen with its billing desk and newsletter, Jonas and Priya on their own. */
function fixture() {
	return indexDirectory(
		directory({
			people: [
				person('lena@lumen.example', {
					name: 'Lena Hartmann',
					companyKey: 'lumen.example',
					topicIds: ['contract'],
				}),
				person('tom@lumen.example', {
					name: 'Tom Becker',
					companyKey: 'lumen.example',
					topicIds: ['budget'],
				}),
				person('jonas@gmail.com', { name: 'Jonas Weber', topicIds: ['lake', 'meetup'] }),
				person('priya@raman.example', {
					name: 'Priya Raman',
					companyKey: 'raman.example',
					topicIds: ['meetup'],
				}),
			],
			accounts: [
				account('billing@lumen.example', {
					name: 'Billing',
					isAutomated: false,
					topicIds: ['invoice-question'],
				}),
				account('news@lumen.example', {
					name: 'Lumen Studio',
					kind: 'newsletter',
					topicIds: ['issue'],
				}),
			],
			companies: [
				company('lumen.example', {
					name: 'Lumen Studio',
					personKeys: ['lena@lumen.example', 'tom@lumen.example'],
					accountKeys: ['billing@lumen.example', 'news@lumen.example'],
				}),
				company('raman.example', { personKeys: ['priya@raman.example'] }),
			],
			topics: [
				topic('contract', {
					partyKeys: ['lena@lumen.example'],
					latestFromKey: 'lena@lumen.example',
					snippet: 'Hi Dev, could you send the signed copy back by Friday? Best, Lena',
					lastMessageAt: NOW - 2 * 3600_000,
					turn: 'you',
					unreadCount: 1,
				}),
				topic('budget', {
					partyKeys: ['tom@lumen.example'],
					latestFromKey: 'tom@lumen.example',
					lastMessageAt: NOW - 3 * 3600_000,
				}),
				topic('invoice-question', {
					partyKeys: ['billing@lumen.example'],
					lastMessageAt: NOW - 10 * DAY,
				}),
				topic('issue', { partyKeys: ['news@lumen.example'], lastMessageAt: NOW - 3600_000 }),
				topic('lake', {
					partyKeys: ['jonas@gmail.com'],
					latestFromKey: null,
					snippet: 'Saturday works for me.',
					lastMessageAt: NOW - DAY,
				}),
				topic('meetup', {
					partyKeys: ['priya@raman.example', 'jonas@gmail.com'],
					latestFromKey: 'priya@raman.example',
					lastMessageAt: NOW - 4 * 3600_000,
				}),
			],
		})
	);
}

describe('paneRows', () => {
	it('lists people, companies and group conversations newest first, machine mail apart', () => {
		const rows = paneRows(fixture());
		expect(rows.map((row) => `${row.kind}:${row.key}`)).toEqual([
			'company:lumen.example',
			'group:meetup',
			'person:jonas@gmail.com',
		]);
	});

	it('nests a company’s people and departments under it, never also at the top', () => {
		const lumen = paneRows(fixture()).find((row) => row.kind === 'company');
		expect(lumen?.kind === 'company' && lumen.members.map((m) => m.key)).toEqual([
			'lena@lumen.example',
			'tom@lumen.example',
			'billing@lumen.example',
		]);
		expect(lumen?.line).toEqual({
			author: 'Lena',
			text: 'Could you send the signed copy back by Friday?',
		});
		expect(lumen?.isUnread).toBe(true);
	});

	it('says the mailbox wrote last, and leaves a person who is only in a group to the group', () => {
		const rows = paneRows(fixture());
		const jonas = rows.find((row) => row.key === 'jonas@gmail.com');
		expect(jonas?.line).toEqual({ author: null, text: 'Saturday works for me.' });
		expect(rows.some((row) => row.key === 'priya@raman.example')).toBe(false);
	});

	it('finds a company by one of its people and a group by a member', () => {
		expect(paneRows(fixture(), 'tom').map((row) => row.key)).toEqual(['lumen.example']);
		expect(paneRows(fixture(), 'priya').map((row) => row.key)).toEqual(['meetup']);
	});
});

describe('isGroupTopic and groupName', () => {
	it('calls colleagues writing together their company’s conversation, not a group', () => {
		const index = fixture();
		expect(
			isGroupTopic(index, topic('x', { partyKeys: ['lena@lumen.example', 'tom@lumen.example'] }))
		).toBe(false);
		expect(isGroupTopic(index, index.topics.get('meetup')!)).toBe(true);
	});

	it('names two people and counts the rest', () => {
		const index = fixture();
		const people = [...index.people.values()];
		expect(groupName(people.slice(0, 3))).toEqual({ names: 'Lena, Tom', more: 1 });
	});
});

describe('updateTopics', () => {
	it('holds only mail from automated senders, optionally one company’s', () => {
		expect(updateTopics(fixture()).map((t) => t.id)).toEqual(['issue']);
		expect(updateTopics(fixture(), 'raman.example')).toEqual([]);
	});
});

describe('pageConversations', () => {
	const index = indexDirectory(
		directory({
			topics: [
				topic('ask', { turn: 'you', lastMessageAt: NOW - DAY }),
				topic('wait', { turn: 'them', lastMessageAt: NOW - 2 * DAY }),
				topic('new', { lastMessageAt: NOW - 3600_000 }),
				topic('done', { isCurrent: false, isArchived: true, lastMessageAt: NOW - 30 * DAY }),
			],
		})
	);
	const ids = ['ask', 'wait', 'new', 'done'];

	it('keeps current conversations newest first, whoever’s turn it is, and Earlier apart', () => {
		const page = pageConversations(index, ids, { focus: 'all' });
		expect(page.current.map((t) => t.id)).toEqual(['new', 'ask', 'wait']);
		expect(page.earlier.map((t) => t.id)).toEqual(['done']);
		expect(page.counts).toEqual({ all: 3, reply: 1, waiting: 1 });
	});

	it('narrows to what may need a reply, without Earlier', () => {
		const page = pageConversations(index, ids, { focus: 'reply' });
		expect(page.current.map((t) => t.id)).toEqual(['ask']);
		expect(page.earlier).toEqual([]);
	});
});

describe('rowSaying', () => {
	const index = fixture();
	const lena = (overrides: Partial<PeopleTopic>) =>
		topic('t', {
			partyKeys: ['lena@lumen.example'],
			latestFromKey: 'lena@lumen.example',
			turn: 'you',
			snippet: 'Thanks! Could you send the signed copy?',
			...overrides,
		});

	it('says what is asked in the model’s words first, with the due date the brief holds', () => {
		const dueAt = NOW + 2 * DAY;
		expect(
			rowSaying(
				index,
				lena({
					askSummary: 'Return the signed copy',
					openItem: { text: { en: 'Send it', de: 'Senden' }, dueAt, isOurs: true },
				}),
				'en'
			)
		).toEqual({ kind: 'ask', author: 'Lena', text: 'Return the signed copy', dueAt });
	});

	it('falls back to the brief, then to the sentence that asks', () => {
		expect(
			rowSaying(
				index,
				lena({ openItem: { text: { en: 'Send it', de: 'Senden' }, isOurs: true } }),
				'de'
			)
		).toEqual({ kind: 'ask', author: 'Lena', text: 'Senden' });
		expect(rowSaying(index, lena({}), 'en')).toEqual({
			kind: 'ask',
			author: 'Lena',
			text: 'Could you send the signed copy?',
		});
	});

	it('shows the latest words once it is not the mailbox’s turn', () => {
		expect(rowSaying(index, lena({ turn: 'none', snippet: 'Great, see you then.' }), 'en')).toEqual(
			{
				kind: 'line',
				line: { author: 'Lena', text: 'Great, see you then.' },
			}
		);
	});
});

describe('replyNames', () => {
	it('names the people whose current conversation ends in a request, most recent first', () => {
		const index = indexDirectory(
			directory({
				people: [person('a@x.example', { name: 'Ana' }), person('b@y.example', { name: 'Ben' })],
				topics: [
					topic('1', { latestFromKey: 'a@x.example', turn: 'you', lastMessageAt: NOW - DAY }),
					topic('2', { latestFromKey: 'b@y.example', turn: 'you', lastMessageAt: NOW - 3600_000 }),
					topic('3', {
						latestFromKey: 'a@x.example',
						turn: 'you',
						isCurrent: false,
						lastMessageAt: NOW,
					}),
				],
			})
		);
		expect(replyNames(index).map((p) => p.name)).toEqual(['Ben', 'Ana']);
	});
});

describe('dayGroups and dueUrgency', () => {
	it('groups today, yesterday, this week, then by month', () => {
		const at = (ms: number) => ({ lastMessageAt: ms });
		const groups = dayGroups(
			[
				at(NOW - 3600_000),
				at(NOW - DAY),
				at(NOW - 3 * DAY),
				at(NOW - 40 * DAY),
				at(NOW - 41 * DAY),
			],
			NOW
		);
		expect(groups.map((g) => [g.bucket, g.items.length])).toEqual([
			['today', 1],
			['yesterday', 1],
			['week', 1],
			['month', 2],
		]);
	});

	it('marks a date due only when it is today or past', () => {
		expect(dueUrgency(NOW + 3600_000, NOW)).toBe('due');
		expect(dueUrgency(NOW - DAY, NOW)).toBe('due');
		expect(dueUrgency(NOW + 2 * DAY, NOW)).toBe('soon');
	});
});
