import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
	buildComposeInput,
	buildTransactionalListUnsubscribe,
	resolveWorkerMessageType,
} from '../worker';
import { composeForSend, type TransformConfig } from '../sendComposition';
import { transformHtml } from '../sendComposition/transform';
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
	it('builds the List-Unsubscribe header and the footer for a SEGMENT audience', () => {
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
		// A segment gets the same visible footer a topic does: the footer names
		// no topic, and its unsubscribe link is contact-scoped.
		expect(composeInput.unsubscribeUrl).toMatch(/^https:\/\/app\.example\/unsubscribe\?token=/);
		expect(composeInput.preferenceUrl).toMatch(/^https:\/\/app\.example\/preferences\?token=/);
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

describe('worker.buildComposeInput — the visible footer on marketing mail', () => {
	// What `delivery/nonCampaignIntake.intake` hands the pool for an automation
	// email step.
	const automationEnvelope = {
		kind: 'transactional' as const,
		deliveryDomain: 'production' as const,
		messageType: 'automation' as const,
		emailPurpose: 'marketing' as const,
		to: 'jane@example.com',
		from: 'drip@org.example',
		template: { subject: 'Welcome', htmlContent: '<body><p>Welcome aboard</p></body>' },
		contactId: CONTACT_ID,
		listUnsubscribe: true,
		convexSiteUrl: 'https://convex.example',
		siteUrl: 'https://app.example',
	};

	function deliveredHtml(envelope: Parameters<typeof buildComposeInput>[0]): string {
		const composed = composeForSend(buildComposeInput(envelope));
		return composed.transformConfig
			? transformHtml(composed.html, composed.transformConfig)
			: composed.html;
	}

	it('a segment campaign is delivered with the footer, its links left unwrapped', () => {
		const html = deliveredHtml({
			...baseCampaign,
			audienceType: 'segment',
			trackingBaseUrl: 'https://track.example',
		});
		expect(html).toContain('Unsubscribe</a>');
		expect(html).toMatch(/href="https:\/\/app\.example\/unsubscribe\?token=[^"]+"/);
		expect(html).toMatch(/href="https:\/\/app\.example\/preferences\?token=[^"]+"/);
	});

	it('an automation email step is delivered with the footer in both parts', () => {
		const composed = composeForSend(buildComposeInput(automationEnvelope));
		expect(composed.transformConfig?.unsubscribeUrl).toMatch(
			/^https:\/\/app\.example\/unsubscribe\?token=/
		);
		expect(composed.text).toContain(`Unsubscribe: ${composed.transformConfig?.unsubscribeUrl}`);
		const html = deliveredHtml(automationEnvelope);
		expect(html).toContain('Manage Preferences</a>');
		expect(html).toContain('Unsubscribe</a>');
	});

	it('the footer rides with the header pair: no one-click header, no footer', () => {
		expect(buildTransactionalListUnsubscribe(automationEnvelope)['List-Unsubscribe']).toBeDefined();
		const { contactId: _contact, ...anonymous } = automationEnvelope;
		expect(buildTransactionalListUnsubscribe(anonymous)).toEqual({});
		expect(composeForSend(buildComposeInput(anonymous)).transformConfig).toBeNull();
	});

	it('an automation seed probe renders the footer against its own probe token', () => {
		const { contactId: _contact, siteUrl: _site, ...probeBase } = automationEnvelope;
		const composed = composeForSend(
			buildComposeInput({
				...probeBase,
				organizationId: 'org_1',
				seedProbeId: 'sp_a1b2c3d4e5f60718293a4b',
				seedProbeRef: 'probe1' as Id<'seedPlacementProbes'>,
			})
		);
		expect(composed.transformConfig?.unsubscribeUrl).toContain(
			'https://convex.example/unsub/probe/'
		);
		expect(composed.transformConfig?.preferenceUrl).toContain(
			'https://convex.example/unsub/probe/'
		);
	});

	it('transactional mail without showUnsubscribe still gets no footer', () => {
		const html = deliveredHtml({
			kind: 'transactional',
			emailPurpose: 'transactional',
			to: 'jane@example.com',
			from: 'system@org.example',
			template: { subject: 'Receipt', htmlContent: '<body><p>Thanks</p></body>' },
			contactId: CONTACT_ID,
			siteUrl: 'https://app.example',
		});
		expect(html).not.toContain('Unsubscribe');
	});

	it('transactional mail with showUnsubscribe keeps its opt-in footer', () => {
		const html = deliveredHtml({
			kind: 'transactional',
			emailPurpose: 'transactional',
			to: 'jane@example.com',
			from: 'system@org.example',
			template: { subject: 'Digest', htmlContent: '<body><p>Your digest</p></body>' },
			contactId: CONTACT_ID,
			siteUrl: 'https://app.example',
			showUnsubscribe: true,
		});
		expect(html).toContain('Unsubscribe</a>');
	});
});

describe('worker legacy message-type derivation', () => {
	it('keeps an old marketing transactional envelope on the automation route', () => {
		expect(
			resolveWorkerMessageType({
				kind: 'transactional',
				emailPurpose: 'marketing',
				to: 'person@example.com',
				from: 'automation@example.org',
				template: { subject: 'Legacy drip', htmlContent: '<p>Hello</p>' },
			})
		).toBe('automation');
	});

	it('honors an explicit message type and derives old transactional mail', () => {
		const envelope = {
			kind: 'transactional' as const,
			emailPurpose: 'transactional' as const,
			to: 'person@example.com',
			from: 'system@example.org',
			template: { subject: 'Receipt', htmlContent: '<p>Thanks</p>' },
		};
		expect(resolveWorkerMessageType(envelope)).toBe('transactional');
		expect(resolveWorkerMessageType({ ...envelope, messageType: 'automation' })).toBe('automation');
	});
});

// CL-01: the agent 1:1 reply path collapses onto the transactional envelope, so
// `delivery/nonCampaignIntake.intake` threads `autoSubmittedType: 'auto-replied'` through
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

describe('worker — the envelope carries the template text/plain body to the composer', () => {
	// The footer's two links, as the text part spells them out.
	function footerText(config: TransformConfig | null): string {
		return `Manage Preferences: ${config?.preferenceUrl}\nUnsubscribe: ${config?.unsubscribeUrl}`;
	}

	it('campaign: the stored body becomes the text part', () => {
		const composed = composeForSend(
			buildComposeInput({
				...baseCampaign,
				template: {
					...baseCampaign.template,
					plainTextContent: 'Hi {{firstName}}\n\nRead more (https://docs.example)',
				},
			})
		);
		expect(composed.text).toBe(
			'Hi Jane\n\nRead more (https://docs.example)\n\n' + footerText(composed.transformConfig)
		);
	});

	it('campaign: an envelope without one still gets a text part from the html', () => {
		const composed = composeForSend(buildComposeInput(baseCampaign));
		expect(composed.text).toBe('Hi Jane\n\n' + footerText(composed.transformConfig));
	});
});
