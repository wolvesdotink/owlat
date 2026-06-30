import { describe, it, expect } from 'vitest';
import { WEBHOOK_EVENT_REGISTRY } from '../registry';
import { emailBounced } from '../emailBounced';
import { emailComplained } from '../emailComplained';
import { emailSent } from '../emailSent';
import { emailDelivered } from '../emailDelivered';
import { emailOpened } from '../emailOpened';
import { emailClicked } from '../emailClicked';
import { contactCreated } from '../contactCreated';
import { topicUnsubscribed } from '../topicUnsubscribed';
import { test as testEvent } from '../test';
import type { Id } from '../../../_generated/dataModel';

describe('WEBHOOK_EVENT_REGISTRY', () => {
	it('registers all 9 modules under their wire literals', () => {
		expect(Object.keys(WEBHOOK_EVENT_REGISTRY).sort()).toEqual(
			[
				'contact.created',
				'email.bounced',
				'email.clicked',
				'email.complained',
				'email.delivered',
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

describe('emailBounced.build', () => {
	it('renders the documented payload shape', () => {
		const data = emailBounced.build({
			email: 'foo@example.com',
			bounceType: 'hard',
			message: 'user unknown',
			at: TS_EPOCH,
		});
		expect(data).toEqual({
			email: 'foo@example.com',
			bounceType: 'hard',
			message: 'user unknown',
			timestamp: TS_ISO,
		});
	});

	it('defaults missing message to empty string', () => {
		const data = emailBounced.build({
			email: 'foo@example.com',
			bounceType: 'soft',
			at: TS_EPOCH,
		});
		expect(data.message).toBe('');
	});
});

describe('emailComplained.build', () => {
	it('renders {email, timestamp}', () => {
		expect(
			emailComplained.build({ email: 'foo@example.com', at: TS_EPOCH })
		).toEqual({ email: 'foo@example.com', timestamp: TS_ISO });
	});
});

describe('emailSent.build', () => {
	it('renders nulls for missing campaign/transactional IDs', () => {
		const data = emailSent.build({ email: 'foo@example.com', at: TS_EPOCH });
		expect(data).toEqual({
			email: 'foo@example.com',
			campaignId: null,
			transactionalEmailId: null,
			timestamp: TS_ISO,
		});
	});

	it('passes through campaignId when supplied', () => {
		const data = emailSent.build({
			email: 'foo@example.com',
			campaignId: 'cmp_abc' as Id<'campaigns'>,
			at: TS_EPOCH,
		});
		expect(data.campaignId).toBe('cmp_abc');
		expect(data.transactionalEmailId).toBeNull();
	});

	it('passes through transactionalEmailId when supplied', () => {
		const data = emailSent.build({
			email: 'foo@example.com',
			transactionalEmailId: 'tx_xyz' as Id<'transactionalEmails'>,
			at: TS_EPOCH,
		});
		expect(data.transactionalEmailId).toBe('tx_xyz');
		expect(data.campaignId).toBeNull();
	});
});

describe('emailDelivered/Opened.build', () => {
	it('emailDelivered renders {email, timestamp}', () => {
		expect(
			emailDelivered.build({ email: 'foo@example.com', at: TS_EPOCH })
		).toEqual({ email: 'foo@example.com', timestamp: TS_ISO });
	});

	it('emailOpened renders {email, timestamp}', () => {
		expect(
			emailOpened.build({ email: 'foo@example.com', at: TS_EPOCH })
		).toEqual({ email: 'foo@example.com', timestamp: TS_ISO });
	});
});

describe('emailClicked.build', () => {
	it('renders {email, url, timestamp}', () => {
		expect(
			emailClicked.build({
				email: 'foo@example.com',
				url: 'https://example.com/landing',
				at: TS_EPOCH,
			})
		).toEqual({
			email: 'foo@example.com',
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
