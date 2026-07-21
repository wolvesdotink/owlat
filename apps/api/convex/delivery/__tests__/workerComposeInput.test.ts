import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildComposeInput, buildTransactionalListUnsubscribe } from '../worker';
import { composeForSend } from '../sendComposition';
import { isAutomatedMail } from '../../lib/inboundClassification';
import type { Id } from '../../_generated/dataModel';

const CONTACT_ID = 'contact1' as Id<'contacts'>;
const SEND_ID = 'send1' as Id<'emailSends'>;

// The List-Unsubscribe / unsubscribe-footer URLs are HMAC-signed with
// UNSUBSCRIBE_SECRET; provide a deterministic one for the build-only assertions.
const PREV_SECRET = process.env['UNSUBSCRIBE_SECRET'];
beforeAll(() => {
	process.env['UNSUBSCRIBE_SECRET'] = 'test-unsubscribe-secret';
});
afterAll(() => {
	if (PREV_SECRET === undefined) delete process.env['UNSUBSCRIBE_SECRET'];
	else process.env['UNSUBSCRIBE_SECRET'] = PREV_SECRET;
});

const baseCampaign = {
	kind: 'campaign' as const,
	to: 'jane@example.com',
	from: 'news@org.example',
	template: { subject: 'Hi {{firstName}}', htmlContent: '<p>Hi {{firstName}}</p>' },
	contactInfo: {
		contactId: CONTACT_ID,
		email: 'jane@example.com',
		firstName: 'Jane',
		lastName: 'Doe',
	},
	emailSendId: SEND_ID,
	convexSiteUrl: 'https://convex.example',
	siteUrl: 'https://app.example',
};

describe('worker.buildComposeInput — campaign List-Unsubscribe', () => {
	it('builds the List-Unsubscribe header for a SEGMENT audience', () => {
		const composeInput = buildComposeInput({
			...baseCampaign,
			audienceType: 'segment',
		});

		// The header is built for segment blasts too — Gmail/Yahoo 2024 bulk rule.
		// It points at the convex one-click /unsub endpoint and removes by
		// contactId across all topics.
		if (composeInput.kind !== 'campaign') throw new Error('expected campaign input');
		expect(composeInput.listUnsubscribeHeader).toBeDefined();
		expect(composeInput.listUnsubscribeHeader?.listUnsubscribe).toMatch(
			/^<https:\/\/convex\.example\/unsub\/[^>]+>$/
		);
		expect(composeInput.listUnsubscribeHeader?.listUnsubscribePost).toBe(
			'List-Unsubscribe=One-Click'
		);
		// The in-body footer stays topic-only for segments.
		expect(composeInput.unsubscribeUrl).toBeUndefined();
		expect(composeInput.preferenceUrl).toBeUndefined();
	});

	it('builds header + footer for a TOPIC audience', () => {
		const composeInput = buildComposeInput({
			...baseCampaign,
			audienceType: 'topic',
		});
		if (composeInput.kind !== 'campaign') throw new Error('expected campaign input');
		expect(composeInput.listUnsubscribeHeader).toBeDefined();
		expect(composeInput.unsubscribeUrl).toBeDefined();
		expect(composeInput.preferenceUrl).toBeDefined();
	});

	it('forwards a pre-built List-Id (RFC 2919) from the envelope to the composer input', () => {
		const composeInput = buildComposeInput({
			...baseCampaign,
			audienceType: 'topic',
			listId: '"Acme Newsletter" <topic-k123.news.org.example>',
		});
		if (composeInput.kind !== 'campaign') throw new Error('expected campaign input');
		expect(composeInput.listId).toBe('"Acme Newsletter" <topic-k123.news.org.example>');
	});

	it('leaves listId undefined when the envelope carries none (e.g. segment campaigns)', () => {
		const composeInput = buildComposeInput({
			...baseCampaign,
			audienceType: 'segment',
		});
		if (composeInput.kind !== 'campaign') throw new Error('expected campaign input');
		expect(composeInput.listId).toBeUndefined();
	});

	it('omits the header when there is no contactId', () => {
		const composeInput = buildComposeInput({
			...baseCampaign,
			audienceType: 'segment',
			contactInfo: { email: 'jane@example.com' },
		});
		if (composeInput.kind !== 'campaign') throw new Error('expected campaign input');
		expect(composeInput.listUnsubscribeHeader).toBeUndefined();
	});

	it('omits the header when there is no convexSiteUrl', () => {
		const { convexSiteUrl: _omit, ...noConvex } = baseCampaign;
		const composeInput = buildComposeInput({
			...noConvex,
			audienceType: 'segment',
		});
		if (composeInput.kind !== 'campaign') throw new Error('expected campaign input');
		expect(composeInput.listUnsubscribeHeader).toBeUndefined();
	});
});

describe('worker.buildTransactionalListUnsubscribe — automation marketing sends', () => {
	const baseTransactional = {
		kind: 'transactional' as const,
		emailPurpose: 'transactional' as const,
		to: 'jane@example.com',
		from: 'drip@org.example',
		template: { subject: 's', htmlContent: '<p></p>' },
	};

	it('builds both List-Unsubscribe headers for a flagged marketing send', () => {
		const headers = buildTransactionalListUnsubscribe({
			...baseTransactional,
			listUnsubscribe: true,
			contactId: CONTACT_ID,
			convexSiteUrl: 'https://convex.example',
		});

		expect(headers['List-Unsubscribe']).toMatch(/^<https:\/\/convex\.example\/unsub\/[^>]+>$/);
		expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
	});

	it('returns no headers when not flagged as marketing', () => {
		expect(
			buildTransactionalListUnsubscribe({
				...baseTransactional,
				contactId: CONTACT_ID,
				convexSiteUrl: 'https://convex.example',
			})
		).toEqual({});
	});

	it('returns no headers when missing contactId or convexSiteUrl', () => {
		expect(
			buildTransactionalListUnsubscribe({
				...baseTransactional,
				listUnsubscribe: true,
				convexSiteUrl: 'https://convex.example',
			})
		).toEqual({});
		expect(
			buildTransactionalListUnsubscribe({
				...baseTransactional,
				listUnsubscribe: true,
				contactId: CONTACT_ID,
			})
		).toEqual({});
	});

	it('returns no headers for a campaign envelope (campaigns use the composer)', () => {
		expect(
			buildTransactionalListUnsubscribe({
				...baseCampaign,
				audienceType: 'segment',
			})
		).toEqual({});
	});
});

// CL-01: the agent 1:1 reply path collapses onto the transactional envelope, so
// `enqueueNonCampaignSend` threads `autoSubmittedType: 'auto-replied'` through
// `envelopeInput`. Exercise the full envelope → buildComposeInput → composeForSend
// path to prove the agent reply lands `Auto-Submitted: auto-replied` (RFC 3834 §2)
// with NO List-Unsubscribe, while a plain transactional send keeps `auto-generated`.
describe('worker — agent_reply vs transactional Auto-Submitted (RFC 3834)', () => {
	const baseTransactional = {
		kind: 'transactional' as const,
		emailPurpose: 'transactional' as const,
		to: 'customer@example.com',
		from: 'support@org.example',
		template: { subject: 'Re: your message', htmlContent: '<p>Thanks for reaching out.</p>' },
	};

	it('an agent_reply envelope composes Auto-Submitted: auto-replied and no List-Unsubscribe', () => {
		const composeInput = buildComposeInput({
			...baseTransactional,
			autoSubmittedType: 'auto-replied',
			// Agent replies carry RFC 5322 threading headers but never a marketing
			// List-Unsubscribe — `listUnsubscribe` stays unset.
			headers: { 'In-Reply-To': '<inbound@customer.example>' },
		});
		const composed = composeForSend(composeInput);

		expect(composed.headers['Auto-Submitted']).toBe('auto-replied');
		expect(composed.headers['List-Unsubscribe']).toBeUndefined();
		expect(composed.headers['List-Unsubscribe-Post']).toBeUndefined();
		// `auto-replied` is `!= no`, so the reply stays loop-safe.
		expect(isAutomatedMail(composed.headers)).toBe(true);
	});

	it('a plain transactional envelope (no autoSubmittedType) keeps Auto-Submitted: auto-generated', () => {
		const composeInput = buildComposeInput(baseTransactional);
		const composed = composeForSend(composeInput);

		expect(composed.headers['Auto-Submitted']).toBe('auto-generated');
		expect(composed.headers['List-Unsubscribe']).toBeUndefined();
		expect(isAutomatedMail(composed.headers)).toBe(true);
	});
});
