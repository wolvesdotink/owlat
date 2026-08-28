/**
 * The delivery strip's derivation (plan idea 1).
 *
 * The claims worth pinning are the honest ones:
 *  - a recipient the MTA handed off but the far side has not accepted is NOT
 *    called "delivered" (that lie is the whole reason the strip exists);
 *  - the resend targets exactly the recipients that failed, deduplicated, and
 *    never a recipient that got the mail;
 *  - the strip stays out of the way for the ordinary single-recipient send.
 */
import { describe, it, expect } from 'vitest';

import {
	deliveryStripView,
	isDeliveryStripWorthShowing,
	resendTargets,
	type DeliveryRecipient,
} from '../postboxDeliveryStrip';

const AT = 1_770_000_000_000;

function recipient(over: Partial<DeliveryRecipient> & { idx: number }): DeliveryRecipient {
	return {
		address: `r${over.idx}@example.com`,
		state: 'sent',
		...over,
	};
}

describe('deliveryStripView — row wording', () => {
	it('says "delivered" only once the far side accepted the message', () => {
		const view = deliveryStripView({
			state: 'sent',
			recipients: [
				recipient({ idx: 0, sentAt: AT, acceptedAt: AT + 1000 }),
				recipient({ idx: 1, sentAt: AT }),
			],
		});
		expect(view.rows[0]?.label).toBe('shared.postboxDeliveryStrip.row.delivered');
		expect(view.rows[0]?.at).toBe(AT + 1000);
		// Handed off, not yet accepted: a weaker claim, and a weaker one is what
		// gets rendered.
		expect(view.rows[1]?.label).toBe('shared.postboxDeliveryStrip.row.sent');
		expect(view.rows[1]?.at).toBe(AT);
	});

	it('keeps dispatch order rather than floating failures to the top', () => {
		const view = deliveryStripView({
			state: 'partial',
			recipients: [
				recipient({ idx: 1, state: 'bounced', bouncedAt: AT, address: 'b@example.com' }),
				recipient({ idx: 0, address: 'a@example.com', acceptedAt: AT }),
			],
		});
		expect(view.rows.map((r) => r.address)).toEqual(['a@example.com', 'b@example.com']);
	});

	it('carries the catalog explanation on a failed row and nothing on a good one', () => {
		const view = deliveryStripView({
			state: 'partial',
			recipients: [
				recipient({ idx: 0, acceptedAt: AT }),
				recipient({
					idx: 1,
					state: 'bounced',
					bouncedAt: AT,
					bounceMessage: '452 4.2.2 The email account that you tried to reach is over quota',
				}),
			],
		});
		expect(view.rows[0]?.explanation).toBeNull();
		expect(view.rows[0]?.rawDetail).toBeNull();
		expect(view.rows[1]?.explanation?.cause).toBe('mailbox_full');
		expect(view.rows[1]?.explanation?.fault).toBe('their-mailbox');
		expect(view.rows[1]?.rawDetail).toContain('over quota');
	});

	it('takes a failed row’s tone from the catalog, so a deferral is not painted as a rejection', () => {
		const view = deliveryStripView({
			state: 'bounced',
			recipients: [
				recipient({
					idx: 0,
					state: 'bounced',
					bouncedAt: AT,
					bounceMessage: '451 4.7.1 Greylisting in effect, please try again later',
				}),
			],
		});
		expect(view.rows[0]?.explanation?.cause).toBe('greylisted');
		expect(view.rows[0]?.tone).toBe('neutral');
		expect(view.tone).toBe('neutral');
	});

	it('colours the whole strip by its worst row', () => {
		const view = deliveryStripView({
			state: 'partial',
			recipients: [
				recipient({ idx: 0, acceptedAt: AT }),
				recipient({ idx: 1, state: 'failed', failedAt: AT, errorCode: '5.1.1' }),
			],
		});
		expect(view.tone).toBe('error');
	});
});

describe('resendTargets', () => {
	it('targets exactly the recipients that failed', () => {
		const view = deliveryStripView({
			state: 'partial',
			recipients: [
				recipient({ idx: 0, address: 'ines@northwind.studio', acceptedAt: AT }),
				recipient({ idx: 1, address: 'jonas@acme.example', state: 'bounced', bouncedAt: AT }),
				recipient({ idx: 2, address: 'kim@acme.example', state: 'queued' }),
			],
		});
		expect(resendTargets(view)).toEqual(['jonas@acme.example']);
	});

	it('asks once for an address that was both a To and a Cc', () => {
		const view = deliveryStripView({
			state: 'bounced',
			recipients: [
				recipient({ idx: 0, address: 'Jonas@Acme.example', state: 'failed', failedAt: AT }),
				recipient({ idx: 1, address: 'jonas@acme.example', state: 'failed', failedAt: AT }),
			],
		});
		expect(resendTargets(view)).toEqual(['Jonas@Acme.example']);
	});

	it('offers a resend even when the failure will not fix itself', () => {
		// A DMARC rejection is not retryable as-is, but someone who has since
		// fixed their setup must still be able to send the message again.
		const view = deliveryStripView({
			state: 'bounced',
			recipients: [
				recipient({
					idx: 0,
					address: 'jonas@acme.example',
					state: 'bounced',
					bouncedAt: AT,
					bounceMessage:
						"550 5.7.1 Unauthenticated email from acme.example is not accepted due to domain's DMARC policy.",
				}),
			],
		});
		expect(view.rows[0]?.explanation?.isRetryable).toBe(false);
		expect(resendTargets(view)).toEqual(['jonas@acme.example']);
	});

	it('has nothing to resend when everything landed', () => {
		const view = deliveryStripView({
			state: 'sent',
			recipients: [recipient({ idx: 0, acceptedAt: AT })],
		});
		expect(resendTargets(view)).toEqual([]);
	});
});

describe('isDeliveryStripWorthShowing', () => {
	it('stays out of the way for a single recipient that simply got the mail', () => {
		const view = deliveryStripView({
			state: 'sent',
			recipients: [recipient({ idx: 0, acceptedAt: AT })],
		});
		expect(view.isAllDelivered).toBe(true);
		expect(isDeliveryStripWorthShowing(view)).toBe(false);
	});

	it('shows up for a failure, for anything still in flight, and for a multi-recipient send', () => {
		const failed = deliveryStripView({
			state: 'bounced',
			recipients: [recipient({ idx: 0, state: 'bounced', bouncedAt: AT })],
		});
		const queued = deliveryStripView({
			state: 'queued',
			recipients: [recipient({ idx: 0, state: 'queued' })],
		});
		const many = deliveryStripView({
			state: 'sent',
			recipients: [
				recipient({ idx: 0, acceptedAt: AT }),
				recipient({ idx: 1, acceptedAt: AT }),
			],
		});
		expect([failed, queued, many].map(isDeliveryStripWorthShowing)).toEqual([true, true, true]);
	});
});
