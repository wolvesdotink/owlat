/**
 * The plain-language bounce catalog (plan idea 2).
 *
 * Two properties matter and neither is cosmetic:
 *
 *  1. FAULT ATTRIBUTION IS HONEST. The red row tells someone whether they broke
 *     something. Telling a user their setup is at fault when a stranger's
 *     mailbox is simply full is the worst failure this module can have, so the
 *     real receiver responses (taken from the shared pinning fixture the MTA and
 *     the ramp gate both pin themselves to) are asserted attribution by
 *     attribution.
 *  2. THE CATALOG IS TOTAL. Every category the shipped classifier can emit has
 *     an entry, so a category that reaches the strip can never render blank.
 *
 * The copy itself is asserted through a real catalog lookup — a key that never
 * made it into `en.json` would otherwise pass silently as its own key text.
 */
import { describe, it, expect } from 'vitest';
import {
	SMTP_BLOCK_MESSAGE_SAMPLES,
	SMTP_FAILURE_CATEGORIES,
} from '@owlat/shared/smtpBlockCategories';

import {
	BOUNCE_CATALOG,
	bounceCause,
	bounceFaultKey,
	explainBounce,
	type BounceCause,
} from '../postboxBounceCatalog';
import { createTestI18n } from '~/__tests__/i18n';

const { t, te } = createTestI18n().global;

describe('bounceCause — the classic personal-mail bounces', () => {
	it('reads the RFC 3464 Status field ahead of anything in the prose', () => {
		expect(
			bounceCause({
				bounceMessage: [
					'Final-Recipient: rfc822; jonas@acme.example',
					'Action: failed',
					'Status: 5.1.1',
					'Diagnostic-Code: smtp; 550 sorry, no mailbox here by that name',
				].join('\n'),
			})
		).toBe('mailbox_unknown');
	});

	it('names a full mailbox from the 4.2.2 over-quota response', () => {
		expect(
			bounceCause({
				bounceMessage: '452 4.2.2 The email account that you tried to reach is over quota',
			})
		).toBe('mailbox_full');
	});

	it('names greylisting rather than calling it a failure', () => {
		expect(
			bounceCause({ bounceMessage: '451 4.7.1 Greylisting in effect, please try again later' })
		).toBe('greylisted');
	});

	it('classifies from a bare errorCode when there is no wire text', () => {
		expect(bounceCause({ errorCode: '5.1.1' })).toBe('mailbox_unknown');
	});

	it('falls back to the wording when no enhanced code is present at all', () => {
		expect(bounceCause({ bounceMessage: '550 sorry, no such user here' })).toBe('mailbox_unknown');
		expect(bounceCause({ bounceMessage: '550 message size exceeds maximum permitted' })).toBe(
			'message_too_large'
		);
	});

	it('admits it does not know rather than inventing a diagnosis', () => {
		expect(bounceCause({})).toBe('unknown');
		expect(bounceCause({ bounceMessage: '550 5.5.0 Requested action not taken' })).toBe('unknown');
	});
});

describe('bounceCause — 5.7.1 is split by wording, not by the number', () => {
	// Receivers use 5.7.1 for both "your message looks like spam" and "your
	// sending identity is not authorised", and those two lead a user to opposite
	// next actions. Getting this split wrong is the whole reason the module reads
	// the wording on this code.
	it('reads a DMARC rejection as the sender setup', () => {
		const cause = bounceCause({
			bounceMessage:
				"550 5.7.1 Unauthenticated email from acme.example is not accepted due to domain's DMARC policy.",
		});
		expect(cause).toBe('policy_rejected');
		expect(BOUNCE_CATALOG[cause].fault).toBe('your-setup');
	});

	it('reads a spam rejection as the receiving side', () => {
		const cause = bounceCause({
			bounceMessage:
				'550-5.7.1 [203.0.113.10] Our system has detected that this message is likely unsolicited mail. To reduce the amount of spam sent to Gmail, this message has been blocked.',
		});
		expect(cause).toBe('content_rejected');
		expect(BOUNCE_CATALOG[cause].fault).toBe('their-mailbox');
	});
});

describe('fault attribution over the shared receiver-response fixture', () => {
	// `SMTP_BLOCK_MESSAGE_SAMPLES` is the array the MTA's classifier and the
	// ramp's hard stop both pin themselves to — real 4xx/5xx shapes, not invented
	// strings. Running the catalog over the same samples is what keeps the words
	// a user reads tied to the responses receivers actually send.
	it.each(SMTP_BLOCK_MESSAGE_SAMPLES.map((s) => [s.category, s] as const))(
		'attributes the %s sample without blaming the wrong party',
		(_category, sample) => {
			const explanation = explainBounce({
				bounceMessage: sample.response,
				errorCode: sample.enhancedCode,
			});
			// A BLOCK is the receiver refusing our sending identity or our content —
			// never a "wait and it will fix itself" line.
			if (sample.isBlock) {
				// A refusal never reads as "wait and it will sort itself out", and
				// never offers a resend that would be refused identically.
				expect(explanation.fault).not.toBe('temporary');
				expect(explanation.isRetryable).toBe(false);
			} else {
				// The non-block samples are rate pressure and one over-quota mailbox:
				// receiver-side conditions. None of them is the user's setup, so none
				// may send them off to change DNS records that are fine.
				expect(explanation.fault).not.toBe('your-setup');
				expect(explanation.isRetryable).toBe(true);
			}
		}
	);

	it('never sends a user to fix their own setup over someone else’s full mailbox', () => {
		const explanation = explainBounce({
			bounceMessage: '452 4.2.2 The email account that you tried to reach is over quota',
		});
		expect(explanation.fault).toBe('their-mailbox');
		expect(explanation.cause).toBe('mailbox_full');
	});
});

describe('the catalog is total and every line resolves', () => {
	it('carries an entry for every category the shipped classifier can emit', () => {
		const missing = [...SMTP_FAILURE_CATEGORIES].filter((c) => !(c in BOUNCE_CATALOG));
		expect(missing).toEqual([]);
	});

	it.each(Object.keys(BOUNCE_CATALOG) as BounceCause[])('%s resolves to real copy', (cause) => {
		const entry = BOUNCE_CATALOG[cause];
		const summary = typeof entry.summary === 'string' ? entry.summary : entry.summary.key;
		expect(te(summary)).toBe(true);
		expect(t(summary)).not.toBe(summary);
		if (entry.action) {
			const action = typeof entry.action === 'string' ? entry.action : entry.action.key;
			expect(te(action)).toBe(true);
			expect(t(action)).not.toBe(action);
		}
	});

	it.each(['your-setup', 'their-mailbox', 'temporary'] as const)(
		'the %s attribution has a rendered label',
		(fault) => {
			expect(te(bounceFaultKey(fault))).toBe(true);
		}
	);
});
