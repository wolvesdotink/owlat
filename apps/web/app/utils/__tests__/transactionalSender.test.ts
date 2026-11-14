import { describe, expect, it } from 'vitest';
import {
	initialSenderDraft,
	isSenderDraftChanged,
	senderDraftAddress,
	senderDraftVerdict,
	splitSenderAddress,
} from '../transactionalSender';

const DOMAINS = [
	{ domain: 'example.com', isVerified: true },
	{ domain: 'mail.example.com', isVerified: true },
	{ domain: 'news.example.com', isVerified: false },
];

const draft = (localPart: string, domain: string, name = '') => ({ localPart, domain, name });

describe('the transactional sender form', () => {
	it('splits and joins an address', () => {
		expect(splitSenderAddress(' noreply@Mail.Example.com ')).toEqual({
			localPart: 'noreply',
			domain: 'mail.example.com',
		});
		expect(senderDraftAddress(draft(' noreply ', 'Mail.example.com'))).toBe(
			'noreply@mail.example.com'
		);
		expect(senderDraftAddress(draft('noreply', ''))).toBe('');
	});

	it('starts a new sender on the suggested subdomain with the address it replaces', () => {
		expect(
			initialSenderDraft({
				current: null,
				suggestedDomain: 'mail.example.com',
				domains: DOMAINS,
				fallback: { address: 'hello@example.com', name: 'Example' },
			})
		).toEqual(draft('hello', 'mail.example.com', 'Example'));
		expect(
			initialSenderDraft({
				current: null,
				suggestedDomain: null,
				domains: DOMAINS,
				fallback: null,
			})
		).toEqual(draft('', 'example.com'));
		expect(
			initialSenderDraft({
				current: { email: 'receipts@mail.example.com', name: null },
				suggestedDomain: 'mail.example.com',
				domains: DOMAINS,
				fallback: { address: 'hello@example.com', name: 'Example' },
			})
		).toEqual(draft('receipts', 'mail.example.com'));
	});

	it('only lets a sender on a verified domain be saved, and links to Domains otherwise', () => {
		expect(senderDraftVerdict(draft('noreply', 'mail.example.com'), DOMAINS)).toMatchObject({
			tone: 'success',
			canSave: true,
		});
		expect(senderDraftVerdict(draft('noreply', 'news.example.com'), DOMAINS)).toEqual({
			tone: 'warning',
			message: {
				key: 'shared.transactionalSender.verdict.domainUnverified',
				params: { domain: 'news.example.com' },
			},
			canSave: false,
			showDomainsLink: true,
		});
		expect(senderDraftVerdict(draft('noreply', 'other.example'), DOMAINS)).toMatchObject({
			canSave: false,
			showDomainsLink: true,
			message: { key: 'shared.transactionalSender.verdict.domainMissing' },
		});
		expect(senderDraftVerdict(draft('noreply', 'example.com'), [])).toMatchObject({
			canSave: false,
			showDomainsLink: true,
		});
	});

	it('asks for the address first and refuses a malformed one or a multi-line name', () => {
		expect(senderDraftVerdict(draft('', 'example.com'), DOMAINS)).toMatchObject({
			tone: 'neutral',
			canSave: false,
		});
		expect(senderDraftVerdict(draft('no reply', 'example.com'), DOMAINS)).toMatchObject({
			tone: 'warning',
			canSave: false,
		});
		expect(
			senderDraftVerdict(draft('noreply', 'example.com', 'A\nBcc: x@y.test'), DOMAINS)
		).toMatchObject({ canSave: false });
	});

	it('knows when a draft changes nothing', () => {
		const current = { email: 'noreply@example.com', name: 'Example' };
		expect(isSenderDraftChanged(draft('noreply', 'example.com', 'Example '), current)).toBe(false);
		expect(isSenderDraftChanged(draft('noreply', 'example.com', 'Other'), current)).toBe(true);
		expect(isSenderDraftChanged(draft('noreply', 'example.com'), null)).toBe(true);
	});
});
