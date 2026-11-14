import { describe, it, expect } from 'vitest';
import { WEBHOOK_EVENT_REGISTRY } from '../registry';
import { emailBounced } from '../emailBounced';
import { emailComplained } from '../emailComplained';
import { emailSent } from '../emailSent';
import { emailDelivered } from '../emailDelivered';
import { emailFailed } from '../emailFailed';
import { emailOpened } from '../emailOpened';
import { emailClicked } from '../emailClicked';
import { contactCreated } from '../contactCreated';
import { topicUnsubscribed } from '../topicUnsubscribed';
import { test as testEvent } from '../test';
import type { Id } from '../../../_generated/dataModel';

describe('WEBHOOK_EVENT_REGISTRY', () => {
	it('registers all 10 modules under their wire literals', () => {
		expect(Object.keys(WEBHOOK_EVENT_REGISTRY).sort()).toEqual(
			[
				'contact.created',
				'email.bounced',
				'email.clicked',
				'email.complained',
				'email.delivered',
				'email.failed',
				'email.opened',
				'email.sent',
				'test',
				'topic.unsubscribed',
			].sort()
		);
	});

	it('marks `test` as not subscribable; all others subscribable', () => {
		for (const m of Object.values(WEBHOOK_EVENT_REGISTRY)) {
			if (m.literal === 'test') {
				expect(m.isSubscribable).toBe(false);
			} else {
				expect(m.isSubscribable).toBe(true);
			}
		}
	});

	it('every module has a non-empty description', () => {
		for (const m of Object.values(WEBHOOK_EVENT_REGISTRY)) {
			expect(m.description).toBeTruthy();
		}
	});
});

const TS_ISO = '2024-01-01T00:00:00.000Z';
const TS_EPOCH = new Date(TS_ISO).getTime();

/** A transactional API send: the send id the API returned, and its template. */
const API_SEND = { sendId: 'send_1', campaignId: null, templateId: 'tpl_1' };
/** A campaign send: no send id a caller could look up, only the campaign. */
const CAMPAIGN_SEND = { sendId: null, campaignId: 'cmp_abc', templateId: null };

describe('emailBounced.build', () => {
	it('renders the documented payload shape', () => {
		const data = emailBounced.build({
			email: 'foo@example.com',
			identity: API_SEND,
			bounceType: 'hard',
			message: 'user unknown',
			at: TS_EPOCH,
		});
		expect(data).toEqual({
			email: 'foo@example.com',
			...API_SEND,
			bounceType: 'hard',
			message: 'user unknown',
			timestamp: TS_ISO,
		});
	});

	it('defaults missing message to empty string', () => {
		const data = emailBounced.build({
			email: 'foo@example.com',
			identity: API_SEND,
			bounceType: 'soft',
			at: TS_EPOCH,
		});
		expect(data.message).toBe('');
	});
});

describe('emailComplained.build', () => {
	it('renders {email, sendId, campaignId, templateId, timestamp}', () => {
		expect(
			emailComplained.build({ email: 'foo@example.com', identity: CAMPAIGN_SEND, at: TS_EPOCH })
		).toEqual({ email: 'foo@example.com', ...CAMPAIGN_SEND, timestamp: TS_ISO });
	});
});

describe('emailSent.build', () => {
	it('keeps transactionalEmailId as the template id beside the send id', () => {
		const data = emailSent.build({ email: 'foo@example.com', identity: API_SEND, at: TS_EPOCH });
		expect(data).toEqual({
			email: 'foo@example.com',
			...API_SEND,
			transactionalEmailId: 'tpl_1',
			timestamp: TS_ISO,
		});
	});

	it('names the campaign for a campaign send', () => {
		const data = emailSent.build({
			email: 'foo@example.com',
			identity: CAMPAIGN_SEND,
			at: TS_EPOCH,
		});
		expect(data.campaignId).toBe('cmp_abc');
		expect(data.transactionalEmailId).toBeNull();
		expect(data.sendId).toBeNull();
	});
});

describe('emailFailed.build', () => {
	it('renders the send, the error code and the message', () => {
		expect(
			emailFailed.build({
				email: 'foo@example.com',
				identity: API_SEND,
				errorCode: 'DELIVERY_HOLD_EXPIRED',
				message: 'Delivery stayed on hold until the delivery deadline passed',
				at: TS_EPOCH,
			})
		).toEqual({
			email: 'foo@example.com',
			...API_SEND,
			errorCode: 'DELIVERY_HOLD_EXPIRED',
			message: 'Delivery stayed on hold until the delivery deadline passed',
			timestamp: TS_ISO,
		});
	});
});

describe('emailDelivered/Opened.build', () => {
	it('emailDelivered renders {email, sendId, campaignId, templateId, timestamp}', () => {
		expect(
			emailDelivered.build({ email: 'foo@example.com', identity: API_SEND, at: TS_EPOCH })
		).toEqual({ email: 'foo@example.com', ...API_SEND, timestamp: TS_ISO });
	});

	it('emailOpened renders {email, sendId, campaignId, templateId, timestamp}', () => {
		expect(
			emailOpened.build({ email: 'foo@example.com', identity: API_SEND, at: TS_EPOCH })
		).toEqual({ email: 'foo@example.com', ...API_SEND, timestamp: TS_ISO });
	});
});

describe('emailClicked.build', () => {
	it('renders {email, sendId, campaignId, templateId, url, timestamp}', () => {
		expect(
			emailClicked.build({
				email: 'foo@example.com',
				identity: API_SEND,
				url: 'https://example.com/landing',
				at: TS_EPOCH,
			})
		).toEqual({
			email: 'foo@example.com',
			...API_SEND,
			url: 'https://example.com/landing',
			timestamp: TS_ISO,
		});
	});
});

describe('contactCreated.build', () => {
	it.each(['api', 'import', 'form', 'transactional', 'inbound'] as const)(
		'renders source=%s correctly',
		(source) => {
			const data = contactCreated.build({
				contactId: 'c_123' as Id<'contacts'>,
				email: 'new@example.com',
				source,
				at: TS_EPOCH,
			});
			expect(data).toEqual({
				contactId: 'c_123',
				email: 'new@example.com',
				source,
				timestamp: TS_ISO,
			});
		}
	);
});

describe('topicUnsubscribed.build', () => {
	it('JSON-encodes the lists array as listsRemoved string', () => {
		const data = topicUnsubscribed.build({
			contactId: 'c_123' as Id<'contacts'>,
			email: 'leaver@example.com',
			unsubscribedAt: TS_EPOCH,
			lists: [
				{ topicId: 't_1', topicName: 'Newsletter' },
				{ topicId: 't_2', topicName: 'Product Updates' },
			],
		});
		expect(data.contactId).toBe('c_123');
		expect(data.email).toBe('leaver@example.com');
		expect(data.unsubscribedAt).toBe(TS_EPOCH);
		expect(JSON.parse(data.listsRemoved)).toEqual([
			{ topicId: 't_1', topicName: 'Newsletter' },
			{ topicId: 't_2', topicName: 'Product Updates' },
		]);
	});

	it('encodes empty lists as []', () => {
		const data = topicUnsubscribed.build({
			contactId: 'c_123' as Id<'contacts'>,
			email: 'leaver@example.com',
			unsubscribedAt: TS_EPOCH,
			lists: [],
		});
		expect(data.listsRemoved).toBe('[]');
	});
});

describe('test event.build', () => {
	it('renders static message + webhook id/name', () => {
		const data = testEvent.build({
			webhookId: 'wh_42' as Id<'webhooks'>,
			webhookName: 'staging-receiver',
		});
		expect(data).toEqual({
			message: 'This is a test webhook from Owlat',
			webhookId: 'wh_42',
			webhookName: 'staging-receiver',
		});
	});
});
