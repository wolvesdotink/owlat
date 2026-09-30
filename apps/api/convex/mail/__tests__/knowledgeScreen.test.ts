import { describe, it, expect } from 'vitest';
import { knowledgeSkipReason, type MailTrustSignals } from '../knowledgeScreen';

const NORMAL: MailTrustSignals = {
	fromAddress: 'sam@customer.test',
	fromName: 'Sam',
	subject: 'Renewal',
};
const NORMAL_BODY = {
	text: 'We decided to renew the contract for another year starting in March.',
};

describe('knowledgeSkipReason', () => {
	it('lets an ordinary message through', () => {
		expect(knowledgeSkipReason(NORMAL, NORMAL_BODY)).toBeNull();
	});

	it('refuses content the scanner scores suspicious or blocked', () => {
		expect(
			knowledgeSkipReason(
				{ ...NORMAL, subject: 'Your page will be restricted' },
				{ text: 'Dear user, verify your password within 24 hours.' }
			)
		).toBe('content_scan_suspicious');
		expect(
			knowledgeSkipReason(
				{ ...NORMAL, subject: 'Your page will be restricted' },
				{
					text: 'Dear user, verify your password within 24 hours.',
					html:
						'<p>Dear user, verify your password within 24 hours.</p>' +
						'<a href="https://paypa1.fake.xyz/login">https://www.example.com/support</a>',
				}
			)
		).toBe('content_scan_blocked');
	});

	it('refuses a stored Spam or Quarantine verdict', () => {
		expect(knowledgeSkipReason({ ...NORMAL, spamVerdict: 'spam' }, NORMAL_BODY)).toBe(
			'spam_verdict_spam'
		);
		expect(knowledgeSkipReason({ ...NORMAL, spamVerdict: 'quarantine' }, NORMAL_BODY)).toBe(
			'spam_verdict_quarantine'
		);
		expect(knowledgeSkipReason({ ...NORMAL, spamVerdict: 'ham' }, NORMAL_BODY)).toBeNull();
	});

	it('refuses a DMARC fail unless a trusted ARC seal rescued it', () => {
		expect(knowledgeSkipReason({ ...NORMAL, dmarcResult: 'fail' }, NORMAL_BODY)).toBe('dmarc_fail');
		expect(
			knowledgeSkipReason({ ...NORMAL, dmarcResult: 'fail', dmarcOverride: 'arc' }, NORMAL_BODY)
		).toBeNull();
		expect(knowledgeSkipReason({ ...NORMAL, dmarcResult: 'pass' }, NORMAL_BODY)).toBeNull();
	});

	it('refuses a spoofed or look-alike From domain', () => {
		expect(
			knowledgeSkipReason(
				{ ...NORMAL, senderHeuristics: { isFromDomainSpoofed: true } },
				NORMAL_BODY
			)
		).toBe('from_domain_spoofed');
		expect(
			knowledgeSkipReason(
				{ ...NORMAL, senderHeuristics: { lookalikeOfContactDomain: 'customer.test' } },
				NORMAL_BODY
			)
		).toBe('lookalike_contact_domain');
		// A first-time sender alone is not a reason: everyone is new once.
		expect(
			knowledgeSkipReason({ ...NORMAL, senderHeuristics: { isFirstTimeSender: true } }, NORMAL_BODY)
		).toBeNull();
	});
});
