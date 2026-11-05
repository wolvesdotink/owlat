import { describe, expect, it } from 'vitest';
import {
	asksSomething,
	accountKindOf,
	cleanSubject,
	companyKeyOf,
	companyNameFromSender,
	counterpartKind,
	counterpartsOf,
	isArchivedThread,
	isCurrentTopic,
	isOutOfView,
	isRoleAddress,
	nameFromAddress,
	nameFromDomain,
	topicTurn,
} from '../classify';

const noEvidence = { isKnownCorrespondent: false, categories: [] };

describe('counterpartKind', () => {
	it('lets the owner’s remembered label win over every other signal', () => {
		expect(counterpartKind('noreply@shop.example', { ...noEvidence, override: 'person' })).toBe(
			'person'
		);
		expect(
			counterpartKind('lena@lumen.example', {
				isKnownCorrespondent: true,
				categories: ['person'],
				override: 'newsletter',
			})
		).toBe('company');
	});

	it('treats an address the owner wrote to as a person', () => {
		expect(
			counterpartKind('support@shop.example', {
				isKnownCorrespondent: true,
				categories: ['notification'],
			})
		).toBe('person');
	});

	it('follows what the address’s mail was classified as', () => {
		expect(
			counterpartKind('hello@parcel.example', {
				...noEvidence,
				categories: ['receipt', 'notification', 'person'],
			})
		).toBe('company');
		expect(
			counterpartKind('digest@figment.example', { ...noEvidence, categories: ['newsletter'] })
		).toBe('company');
		expect(
			counterpartKind('jonas@studio.example', { ...noEvidence, categories: ['person', 'other'] })
		).toBe('person');
	});

	it('keeps a customer whose subject said “Invoice” a person', () => {
		expect(
			counterpartKind('ben@acmecorp.example', {
				...noEvidence,
				name: 'Ben Ortiz',
				categories: ['receipt'],
			})
		).toBe('person');
		expect(
			counterpartKind('sofia.marin@hartwell.example', {
				...noEvidence,
				categories: ['notification'],
			})
		).toBe('person');
	});

	it('falls back to the local part, and to a person when nothing says otherwise', () => {
		expect(counterpartKind('no-reply@bank.example', noEvidence)).toBe('company');
		expect(counterpartKind('billing+eu@cloud.example', noEvidence)).toBe('company');
		expect(counterpartKind('priya@fernweh.example', noEvidence)).toBe('person');
	});
});

describe('isRoleAddress', () => {
	it('matches department and system senders but not people', () => {
		expect(isRoleAddress('notifications@app.example')).toBe(true);
		expect(isRoleAddress('do-not-reply@app.example')).toBe(true);
		expect(isRoleAddress('lena.hartmann@app.example')).toBe(false);
		expect(isRoleAddress('nora@app.example')).toBe(false);
	});
});

describe('companyKeyOf', () => {
	it('groups subdomains under the organisational domain', () => {
		expect(companyKeyOf('lena@mail.lumenstudio.de')).toBe('lumenstudio.de');
		expect(companyKeyOf('tom@lumenstudio.de')).toBe('lumenstudio.de');
	});

	it('gives freemail addresses no company', () => {
		expect(companyKeyOf('someone@gmail.com')).toBeNull();
		expect(companyKeyOf('someone@gmx.de')).toBeNull();
	});
});

describe('counterpartsOf', () => {
	it('drops the mailbox’s own addresses and duplicates, whatever the casing', () => {
		const own = new Set(['me@owlat.example', 'alias@owlat.example']);
		expect(
			counterpartsOf(
				['Me@Owlat.example', 'Lena@Lumen.example', 'lena@lumen.example', 'alias@owlat.example'],
				own
			)
		).toEqual(['lena@lumen.example']);
	});
});

describe('names', () => {
	it('reads a name from an address', () => {
		expect(nameFromAddress('lena.hartmann@lumen.example')).toBe('Lena Hartmann');
		expect(nameFromAddress('tom_becker+work@lumen.example')).toBe('Tom Becker');
	});

	it('reads a company name from its domain', () => {
		expect(nameFromDomain('lumen-studio.example')).toBe('Lumen Studio');
		expect(nameFromDomain('parcelway.de')).toBe('Parcelway');
	});
});

describe('companyNameFromSender', () => {
	it('keeps the words that spell the domain and drops the department', () => {
		expect(companyNameFromSender('Lumen Studio Billing', 'lumenstudio.example')).toBe(
			'Lumen Studio'
		);
		expect(companyNameFromSender('Parcelway', 'parcelway.example')).toBe('Parcelway');
	});

	it('keeps a name that only contains the domain, and ignores one unrelated to it', () => {
		expect(companyNameFromSender('Team Northbank', 'northbank.example')).toBe('Team Northbank');
		expect(companyNameFromSender('Weekly Digest', 'mailer.example')).toBeNull();
		expect(companyNameFromSender('Weekly Digest', null)).toBe('Weekly Digest');
	});
});

describe('cleanSubject', () => {
	it('strips stacked reply and forward prefixes in several languages', () => {
		expect(cleanSubject('Re: AW: Fwd: Vertrag 2027')).toBe('Vertrag 2027');
		expect(cleanSubject('WG: SV: Re[2]: Budget')).toBe('Budget');
	});

	it('keeps a subject that is only a prefix', () => {
		expect(cleanSubject('Re:')).toBe('Re:');
	});
});

describe('topicTurn', () => {
	it('puts what we owe ahead of what we wait for', () => {
		expect(topicTurn({ isOwedByUs: true, isOwedToUs: true, isLatestFromOwner: true })).toBe('you');
		expect(topicTurn({ isOwedByUs: false, isOwedToUs: true, isLatestFromOwner: false })).toBe(
			'them'
		);
	});

	it('does not call a thread the owner answered last waiting, unless something is owed back', () => {
		expect(topicTurn({ isOwedByUs: false, isOwedToUs: false, isLatestFromOwner: true })).toBe(
			'replied'
		);
		expect(topicTurn({ isOwedByUs: false, isOwedToUs: true, isLatestFromOwner: true })).toBe(
			'them'
		);
		expect(topicTurn({ isOwedByUs: false, isOwedToUs: false, isLatestFromOwner: false })).toBe(
			'none'
		);
	});
});

describe('isCurrentTopic', () => {
	it('keeps every conversation current until it is archived or muted, whatever its age', () => {
		expect(isCurrentTopic({ isArchived: false, isMuted: false })).toBe(true);
		expect(isCurrentTopic({ isArchived: true, isMuted: false })).toBe(false);
		expect(isCurrentTopic({ isArchived: false, isMuted: true })).toBe(false);
	});
});

describe('isOutOfView', () => {
	it('hides threads that live only in Trash, Spam or Drafts', () => {
		expect(isOutOfView(['trash'])).toBe(true);
		expect(isOutOfView(['spam', 'drafts'])).toBe(true);
		expect(isOutOfView(['inbox', 'trash'])).toBe(false);
		expect(isOutOfView([])).toBe(false);
	});
});

describe('isArchivedThread', () => {
	it('is archived once it left the Inbox for Archive', () => {
		expect(isArchivedThread(['archive', 'sent'])).toBe(true);
		expect(isArchivedThread(['archive', 'inbox'])).toBe(false);
		expect(isArchivedThread(['sent'])).toBe(false);
	});
});

describe('accountKindOf', () => {
	it('calls a news address a newsletter whatever its subject read like', () => {
		expect(accountKindOf('news@figment.example', 'notification')).toBe('newsletter');
		expect(accountKindOf('newsletter+de@figment.example', null)).toBe('newsletter');
		expect(accountKindOf('no-reply@parcel.example', 'notification')).toBe('notification');
	});
});

describe('asksSomething', () => {
	it('hears a question or a request, in English and German', () => {
		expect(asksSomething('Would the 9th work for you?')).toBe(true);
		expect(asksSomething('Please send the contract by Friday.')).toBe(true);
		expect(asksSomething('Kannst du mir den Vertrag schicken.')).toBe(true);
	});

	it('does not hear one in thanks or a note', () => {
		expect(asksSomething('Thanks again for the quotes, they made the case studies.')).toBe(false);
		expect(asksSomething('We ship them next week unless you see something.')).toBe(false);
	});
});
