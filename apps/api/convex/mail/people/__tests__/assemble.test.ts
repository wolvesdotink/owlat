import { describe, expect, it } from 'vitest';
import { assembleDirectory, type AddressInput, type ThreadInput } from '../assemble';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const OWN = new Set(['me@owlat.example']);

function thread(overrides: Partial<ThreadInput> & Pick<ThreadInput, 'id'>): ThreadInput {
	return {
		participants: [],
		latestFromAddress: 'me@owlat.example',
		latestSubject: 'Re: Hello',
		latestSnippet: '',
		lastMessageAt: NOW - DAY,
		firstMessageAt: NOW - 3 * DAY,
		messageCount: 2,
		unreadCount: 0,
		hasAttachments: false,
		hasFlagged: false,
		isPinned: false,
		isMuted: false,
		isArchived: false,
		isOwedByUs: false,
		isAskDetected: false,
		isOwedToUs: false,
		...overrides,
	};
}

const known: AddressInput = { isKnownCorrespondent: true, isVip: false };

describe('assembleDirectory', () => {
	it('groups the people of one company with its accounts', () => {
		const directory = assembleDirectory({
			threads: [
				thread({
					id: 't1',
					participants: ['me@owlat.example', 'lena@lumenstudio.de'],
					latestFromAddress: 'lena@lumenstudio.de',
					latestSubject: 'AW: Vertrag 2027',
					isOwedByUs: true,
				}),
				thread({
					id: 't2',
					participants: ['me@owlat.example', 'tom@lumenstudio.de', 'lena@lumenstudio.de'],
					lastMessageAt: NOW - 2 * DAY,
				}),
				thread({
					id: 't3',
					participants: ['billing@lumenstudio.de', 'me@owlat.example'],
					latestFromAddress: 'billing@lumenstudio.de',
					category: 'receipt',
					lastMessageAt: NOW - 5 * DAY,
				}),
			],
			ownAddresses: OWN,
			addresses: new Map([
				['lena@lumenstudio.de', { ...known, name: 'Lena Hartmann', organization: 'Lumen Studio' }],
				['tom@lumenstudio.de', known],
				['billing@lumenstudio.de', { isKnownCorrespondent: false, isVip: false }],
			]),
			now: NOW,
		});

		expect(directory.people.map((p) => p.key)).toEqual([
			'lena@lumenstudio.de',
			'tom@lumenstudio.de',
		]);
		expect(directory.accounts).toMatchObject([
			{
				key: 'billing@lumenstudio.de',
				companyKey: 'lumenstudio.de',
				kind: 'receipt',
				isAutomated: true,
			},
		]);
		expect(directory.companies).toHaveLength(1);
		expect(directory.companies[0]).toMatchObject({
			key: 'lumenstudio.de',
			name: 'Lumen Studio',
			personKeys: ['lena@lumenstudio.de', 'tom@lumenstudio.de'],
			accountKeys: ['billing@lumenstudio.de'],
			topicIds: ['t1', 't2', 't3'],
		});
	});

	it('keeps a department address you correspond with apart from a machine', () => {
		const directory = assembleDirectory({
			threads: [
				thread({
					id: 'q',
					participants: ['billing@acme.example'],
					latestFromAddress: 'billing@acme.example',
					latestSubject: 'Question about invoice 2291',
				}),
				thread({
					id: 'r',
					participants: ['billing@shop.example'],
					latestFromAddress: 'billing@shop.example',
					category: 'receipt',
				}),
				thread({
					id: 's',
					participants: ['no-reply@parcel.example'],
					latestFromAddress: 'no-reply@parcel.example',
				}),
				thread({
					id: 't',
					participants: ['statements@bank.example'],
					latestFromAddress: 'statements@bank.example',
				}),
			],
			ownAddresses: OWN,
			addresses: new Map(),
			now: NOW,
		});
		const automated = Object.fromEntries(
			directory.companies.map((c) => [c.key, c.isAutomated] as const)
		);
		expect(automated).toEqual({
			'acme.example': false,
			'shop.example': true,
			'parcel.example': true,
			'bank.example': true,
		});
	});

	it('names a topic by its title, else by its cleaned subject', () => {
		const { topics } = assembleDirectory({
			threads: [
				thread({ id: 'a', participants: ['x@acme.example'], latestSubject: 'Re: AW: Budget' }),
				thread({
					id: 'b',
					participants: ['x@acme.example'],
					title: { text: 'Q4 budget sign-off', source: 'ai' },
				}),
			],
			ownAddresses: OWN,
			addresses: new Map(),
			now: NOW,
		});
		expect(topics.map((t) => [t.title, t.titleSource])).toEqual([
			['Budget', 'subject'],
			['Q4 budget sign-off', 'ai'],
		]);
	});

	it('counts what a person is owed and keeps freemail people out of companies', () => {
		const directory = assembleDirectory({
			threads: [
				thread({
					id: 'a',
					participants: ['jonas@gmail.com'],
					isOwedByUs: true,
					isAskDetected: true,
				}),
				thread({
					id: 'b',
					participants: ['jonas@gmail.com'],
					lastMessageAt: NOW - 60 * DAY,
					latestFromAddress: 'jonas@gmail.com',
				}),
			],
			ownAddresses: OWN,
			addresses: new Map([['jonas@gmail.com', known]]),
			now: NOW,
		});
		expect(directory.people[0]).toMatchObject({
			key: 'jonas@gmail.com',
			companyKey: null,
			owedCount: 1,
			mayOweCount: 0,
			currentCount: 1,
			topicIds: ['a', 'b'],
		});
		expect(directory.companies).toEqual([]);
	});

	it('claims a reply is owed only on evidence; a heuristic flag only may need one', () => {
		const directory = assembleDirectory({
			threads: [
				thread({
					id: 'flag',
					participants: ['jonas@gmail.com'],
					isOwedByUs: true,
					latestSnippet: 'Are you free on Monday?',
				}),
				thread({
					id: 'brief',
					participants: ['jonas@gmail.com'],
					isOwedByUs: true,
					openItem: { text: { en: 'Send the contract', de: 'Vertrag senden' }, isOurs: true },
				}),
			],
			ownAddresses: OWN,
			addresses: new Map([['jonas@gmail.com', known]]),
			now: NOW,
		});
		expect(directory.topics.map((t) => [t.id, t.turn, t.isAsk])).toEqual([
			['flag', 'you', false],
			['brief', 'you', true],
		]);
		expect(directory.people[0]).toMatchObject({ owedCount: 1, mayOweCount: 1 });
	});

	it('holds a heuristic flag to latest words that ask something', () => {
		const directory = assembleDirectory({
			threads: [
				thread({
					id: 'ask',
					participants: ['jonas@gmail.com'],
					isOwedByUs: true,
					latestFromAddress: 'jonas@gmail.com',
					latestSnippet: 'Could you send the signed copy by Friday?',
				}),
				thread({
					id: 'thanks',
					participants: ['jonas@gmail.com'],
					isOwedByUs: true,
					latestFromAddress: 'jonas@gmail.com',
					latestSnippet: 'The site is live. Thanks again for the quotes.',
				}),
				thread({
					id: 'stale',
					participants: ['jonas@gmail.com'],
					isOwedByUs: true,
					latestFromAddress: 'jonas@gmail.com',
					latestSnippet: 'Would that work for you?',
					lastMessageAt: NOW - 9 * DAY,
				}),
			],
			ownAddresses: OWN,
			addresses: new Map([['jonas@gmail.com', known]]),
			now: NOW,
		});
		expect(directory.topics.map((t) => [t.id, t.turn])).toEqual([
			['ask', 'you'],
			['thanks', 'none'],
			['stale', 'none'],
		]);
	});

	it('counts a request the brief holds as waiting on you without an Answer-queue flag', () => {
		const directory = assembleDirectory({
			threads: [
				thread({
					id: 'brief-only',
					participants: ['jonas@gmail.com'],
					openItem: { text: { en: 'Confirm the date', de: 'Datum bestätigen' }, isOurs: true },
				}),
			],
			ownAddresses: OWN,
			addresses: new Map([['jonas@gmail.com', known]]),
			now: NOW,
		});
		expect(directory.topics[0]).toMatchObject({ turn: 'you', isAsk: true });
		expect(directory.people[0]).toMatchObject({ owedCount: 1 });
	});

	it('lets "No reply needed" silence a request the brief holds', () => {
		const directory = assembleDirectory({
			threads: [
				thread({
					id: 'dismissed',
					participants: ['jonas@gmail.com'],
					latestFromAddress: 'jonas@gmail.com',
					isDismissed: true,
					openItem: { text: { en: 'Confirm the date', de: 'Datum bestätigen' }, isOurs: true },
				}),
			],
			ownAddresses: OWN,
			addresses: new Map([['jonas@gmail.com', known]]),
			now: NOW,
		});
		expect(directory.topics[0]).toMatchObject({ turn: 'none', isAsk: false });
		expect(directory.topics[0]?.openItem).toBeUndefined();
		expect(directory.people[0]).toMatchObject({ owedCount: 0, mayOweCount: 0 });
	});

	it('gives a system sender on a freemail domain a company of its own', () => {
		const directory = assembleDirectory({
			threads: [
				thread({
					id: 'n',
					participants: ['digest.weekly@gmail.com'],
					latestFromAddress: 'digest.weekly@gmail.com',
					category: 'newsletter',
				}),
			],
			ownAddresses: OWN,
			addresses: new Map([
				['digest.weekly@gmail.com', { isKnownCorrespondent: false, isVip: false, name: 'Weekly' }],
			]),
			now: NOW,
		});
		expect(directory.people).toEqual([]);
		expect(directory.companies).toMatchObject([
			{ key: 'address:digest.weekly@gmail.com', name: 'Weekly', domain: null },
		]);
	});

	it('skips threads with nobody else in them', () => {
		const directory = assembleDirectory({
			threads: [thread({ id: 'self', participants: ['me@owlat.example'] })],
			ownAddresses: OWN,
			addresses: new Map(),
			now: NOW,
		});
		expect(directory.topics).toEqual([]);
	});
});
