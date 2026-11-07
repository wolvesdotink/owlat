import { describe, expect, it } from 'vitest';
import { createI18n } from 'vue-i18n';
import en from '~~/i18n/locales/en.json';
import de from '~~/i18n/locales/de.json';
import {
	colleagueLine,
	companyConversationHref,
	companyHref,
	conversationPeople,
	filterCompanies,
	mergeOpenWork,
	personLabel,
	taskAudienceLabel,
} from '../companies';

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en, de } });

function render(
	names: string[],
	unnamed: number,
	locale: 'en' | 'de' = 'en',
	short = false
): string | null {
	const message = colleagueLine(names, unnamed, 'Northwind', { short });
	if (!message) return null;
	i18n.global.locale.value = locale;
	const { t } = i18n.global;
	return message.plural === undefined
		? t(message.key, message.params)
		: t(message.key, message.params, message.plural);
}

describe('colleagueLine', () => {
	it('says nothing when no colleague is in touch', () => {
		expect(colleagueLine([], 0, 'Northwind')).toBeNull();
	});

	it('names up to three colleagues', () => {
		expect(render(['Taylor'], 0)).toBe('Taylor is also in touch with Northwind.');
		expect(render(['Taylor', 'Jordan'], 0)).toBe(
			'Taylor and Jordan are also in touch with Northwind.'
		);
		expect(render(['Taylor', 'Jordan', 'Sam'], 0)).toBe(
			'Taylor, Jordan and Sam are also in touch with Northwind.'
		);
	});

	it('names two and counts the rest past three', () => {
		expect(render(['Taylor', 'Jordan', 'Sam', 'Alex'], 0)).toBe(
			'Taylor, Jordan and 2 others are also in touch with Northwind.'
		);
	});

	it('counts the colleagues the roster cannot name with the others', () => {
		expect(render(['Taylor', 'Jordan'], 1)).toBe(
			'Taylor, Jordan and one other colleague are also in touch with Northwind.'
		);
		expect(render(['Taylor'], 3)).toBe('Taylor and 3 others are also in touch with Northwind.');
		expect(render([], 1)).toBe('Someone on your team is also in touch with Northwind.');
		expect(render([], 2)).toBe('2 people on your team are also in touch with Northwind.');
	});

	it('carries names and the company only: no subject, date or conversation count', () => {
		const message = colleagueLine(['Taylor'], 0, 'Northwind');
		expect(Object.keys(message!.params).sort()).toEqual(['company', 'first']);
	});

	it('reads the same in German', () => {
		expect(render(['Taylor'], 0, 'de')).toBe('Taylor ist auch mit Northwind in Kontakt.');
		expect(render(['Taylor', 'Jordan', 'Sam', 'Alex'], 0, 'de')).toBe(
			'Taylor, Jordan und 2 weitere sind auch mit Northwind in Kontakt.'
		);
	});
});

describe('colleagueLine, short', () => {
	it('drops the company for a summary that already names it', () => {
		expect(render(['Taylor'], 0, 'en', true)).toBe('Taylor also in touch');
		expect(render(['Taylor', 'Jordan', 'Sam', 'Alex'], 0, 'en', true)).toBe(
			'Taylor, Jordan and 2 others also in touch'
		);
		expect(render([], 2, 'en', true)).toBe('2 colleagues also in touch');
		expect(render(['Taylor'], 0, 'de', true)).toBe('Taylor auch in Kontakt');
	});

	it('still carries names only', () => {
		const message = colleagueLine(['Taylor'], 0, 'Northwind', { short: true });
		expect(Object.keys(message!.params).sort()).toEqual(['company', 'first']);
	});
});

describe('mergeOpenWork', () => {
	const task = (id: string, status = 'open') => ({ _id: id, status });

	it('keeps each task once, the conversation’s first, open before done', () => {
		const merged = mergeOpenWork(
			[task('a', 'done'), task('b')],
			[
				[task('b'), task('c')],
				[task('a', 'done'), task('d')],
			]
		);
		expect(merged.map((t) => t._id)).toEqual(['b', 'c', 'd', 'a']);
	});
});

describe('filterCompanies', () => {
	const companies = [
		{ key: 'northwind.example', name: 'Northwind' },
		{ key: 'contoso-labs.example', name: 'Contoso Labs' },
	];

	it('matches every word against the name and the domain, ignoring case', () => {
		expect(filterCompanies(companies, 'NORTH')).toEqual([companies[0]]);
		expect(filterCompanies(companies, 'contoso-labs.example')).toEqual([companies[1]]);
		expect(filterCompanies(companies, 'labs contoso')).toEqual([companies[1]]);
		expect(filterCompanies(companies, 'labs north')).toEqual([]);
	});

	it('keeps every company, in order, for an empty query', () => {
		expect(filterCompanies(companies, '  ')).toEqual(companies);
	});
});

describe('companyConversationHref', () => {
	it('opens a mail thread in the Postbox reader by its newest message', () => {
		expect(
			companyConversationHref({
				kind: 'mail',
				messageId: 'm1',
				mailboxId: 'mb1',
				conversationThreadId: null,
			})
		).toBe('/dashboard/postbox/inbox/m1?mailbox=mb1');
	});

	it('opens a Team Inbox thread by its id', () => {
		expect(
			companyConversationHref({ kind: 'team', mailboxId: null, conversationThreadId: 'ct1' })
		).toBe('/dashboard/inbox/ct1');
	});

	it('is no link for a mail thread whose newest message is unknown', () => {
		expect(
			companyConversationHref({
				kind: 'mail',
				messageId: null,
				mailboxId: 'mb1',
				conversationThreadId: null,
			})
		).toBeNull();
	});
});

describe('the small labels', () => {
	it('links a company by its encoded key', () => {
		expect(companyHref('northwind.example')).toBe('/dashboard/companies/northwind.example');
	});

	it('names a person by their recorded name, else the address', () => {
		expect(personLabel({ address: 'mia@northwind.example', name: 'Mia Weber' })).toBe('Mia Weber');
		expect(personLabel({ address: 'mia@northwind.example', name: '  ' })).toBe(
			'mia@northwind.example'
		);
	});

	it('shows the first people of a conversation by name and counts the rest', () => {
		const people = [{ address: 'mia@northwind.example', name: 'Mia Weber' }];
		expect(
			conversationPeople(
				['mia@northwind.example', 'jonas@northwind.example', 'ana@northwind.example'],
				people
			)
		).toEqual({ shown: ['Mia Weber', 'jonas@northwind.example'], more: 1 });
	});

	it('labels a task by its audience, a group by its own name', () => {
		expect(taskAudienceLabel({ visibility: 'private', groupName: null })).toEqual({
			key: 'components.companies.tasks.audience.private',
		});
		expect(taskAudienceLabel({ visibility: 'group', groupName: 'Sales' })).toEqual({
			text: 'Sales',
		});
		expect(taskAudienceLabel({ visibility: 'group', groupName: null })).toEqual({
			key: 'components.companies.tasks.audience.group',
		});
	});
});
