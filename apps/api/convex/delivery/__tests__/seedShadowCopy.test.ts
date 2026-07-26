import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildSeedShadowEnvelope, isSeedShadowEnvelope } from '../seedShadowCopy';
import type { CampaignEnvelopeInput } from '../seedShadowCopy';
import { buildComposeInput } from '../worker';
import { composeForSend } from '../sendComposition';
import { SEED_PROBE_HEADER } from '@owlat/shared/seedPlacement';
import type { Id } from '../../_generated/dataModel';

const CONTACT_ID = 'contact1' as Id<'contacts'>;
const SEND_ID = 'send1' as Id<'emailSends'>;
const CAMPAIGN_ID = 'campaign1' as Id<'campaigns'>;
const PROBE_ID = 'sp_abcdefghij0123456789kl';
const SEED_ADDRESS = 'owlat.seed.01@gmail.example';

const PREV_SECRET = process.env['UNSUBSCRIBE_SECRET'];
beforeAll(() => {
	process.env['UNSUBSCRIBE_SECRET'] = 'test-unsubscribe-secret';
});
afterAll(() => {
	if (PREV_SECRET === undefined) delete process.env['UNSUBSCRIBE_SECRET'];
	else process.env['UNSUBSCRIBE_SECRET'] = PREV_SECRET;
});

// A real campaign envelope. The template carries no personalization tokens so
// the byte-identity assertions below compare composition, not substitution.
const realSend: CampaignEnvelopeInput = {
	kind: 'campaign',
	deliveryDomain: 'production',
	to: 'jane@example.com',
	from: 'news@org.example',
	replyTo: 'hello@org.example',
	providerType: 'mta',
	ipPool: 'marketing',
	template: { subject: 'March newsletter', htmlContent: '<p>Hello there</p>' },
	contactInfo: {
		contactId: CONTACT_ID,
		email: 'jane@example.com',
		firstName: 'Jane',
		lastName: 'Doe',
	},
	audienceType: 'topic',
	emailSendId: SEND_ID,
	campaignId: CAMPAIGN_ID,
	organizationId: 'org_1',
	siteUrl: 'https://app.example',
	convexSiteUrl: 'https://convex.example',
	trackingBaseUrl: 'https://track.example',
	viewInBrowserUrl: 'https://app.example/archive/1',
	listId: '"March" <topic-1.org.example>',
};

const shadow = buildSeedShadowEnvelope(realSend, {
	address: SEED_ADDRESS,
	probeId: PROBE_ID,
});

/** (b) The shadow copy rides the IDENTICAL composer and the IDENTICAL transport. */
describe('buildSeedShadowEnvelope — identical transport', () => {
	it('keeps the same kind, so it goes through the same worker and composer', () => {
		expect(shadow.kind).toBe('campaign');
	});

	it('keeps the sending identity byte-for-byte (D11 — never a different identity)', () => {
		expect(shadow.from).toBe(realSend.from);
		expect(shadow.replyTo).toBe(realSend.replyTo);
		expect(shadow.deliveryDomain).toBe(realSend.deliveryDomain);
	});

	it('keeps the same transport selection — provider and IP pool', () => {
		expect(shadow.providerType).toBe('mta');
		expect(shadow.ipPool).toBe('marketing');
	});

	it('keeps the same template bytes', () => {
		expect(shadow.template).toEqual(realSend.template);
	});

	it('re-addresses only the recipient', () => {
		expect(shadow.to).toBe(SEED_ADDRESS);
		expect(shadow.contactInfo.email).toBe(SEED_ADDRESS);
	});

	it('does not mutate the real send envelope', () => {
		expect(realSend.to).toBe('jane@example.com');
		expect(realSend.seedProbeId).toBeUndefined();
		expect(realSend.emailSendId).toBe(SEND_ID);
	});
});

describe('buildSeedShadowEnvelope — the probe id', () => {
	it('carries the probe id', () => {
		expect(shadow.seedProbeId).toBe(PROBE_ID);
	});

	it('reaches the wire as the probe header, and only on the shadow copy', () => {
		const shadowHeaders = composeForSend(buildComposeInput(shadow)).headers;
		const realHeaders = composeForSend(buildComposeInput(realSend)).headers;
		expect(shadowHeaders[SEED_PROBE_HEADER]).toBe(PROBE_ID);
		expect(realHeaders[SEED_PROBE_HEADER]).toBeUndefined();
	});

	it('is recognisable as a shadow copy; a real send never is', () => {
		expect(isSeedShadowEnvelope(shadow)).toBe(true);
		expect(isSeedShadowEnvelope(realSend)).toBe(false);
	});
});

describe('shadow composition is identical apart from the probe header', () => {
	const shadowOut = composeForSend(buildComposeInput(shadow));
	const realOut = composeForSend(buildComposeInput(realSend));

	it('produces the same subject, html and plain-text alternative', () => {
		expect(shadowOut.subject).toBe(realOut.subject);
		expect(shadowOut.html).toBe(realOut.html);
		expect(shadowOut.text).toBe(realOut.text);
	});

	it('produces the same bulk-mail and list headers', () => {
		expect(shadowOut.headers['Precedence']).toBe(realOut.headers['Precedence']);
		expect(shadowOut.headers['Auto-Submitted']).toBe(realOut.headers['Auto-Submitted']);
		expect(shadowOut.headers['List-Id']).toBe(realOut.headers['List-Id']);
		expect(shadowOut.headers['Feedback-ID']).toBe(realOut.headers['Feedback-ID']);
	});

	it('adds exactly one header and drops only the contact-scoped List-Unsubscribe pair', () => {
		const differing = new Set<string>();
		for (const key of new Set([
			...Object.keys(shadowOut.headers),
			...Object.keys(realOut.headers),
		])) {
			if (shadowOut.headers[key] !== realOut.headers[key]) differing.add(key);
		}
		// List-Unsubscribe pair is contact-scoped and intentionally absent from the
		// shadow (it would put a real subscriber's one-click token in an operator
		// mailbox); the probe header is the only ADDED header.
		expect([...differing].sort()).toEqual([
			'List-Unsubscribe',
			'List-Unsubscribe-Post',
			SEED_PROBE_HEADER,
		]);
	});
});

/** (b) D18 — EXCLUDED from analytics denominators AND reputation denominators. */
describe('D18 exclusion — a shadow copy is not a Send', () => {
	it('carries no emailSendId, so no emailSends row and no sendRef exist for it', () => {
		expect(shadow.emailSendId).toBeUndefined();
	});

	it('carries no contactId, so no contact-scoped URL or activity can attach', () => {
		expect(shadow.contactInfo.contactId).toBeUndefined();
	});

	it('carries no tracking pixel and no wrapped links — a probe open can never land in a campaign open rate', () => {
		const composed = composeForSend(buildComposeInput(shadow));
		expect(composed.transformConfig?.trackingPixelUrl).toBeUndefined();
		expect(composed.transformConfig?.trackedLinkBase).toBeUndefined();
		// The real send it mirrors DOES carry them — the difference is the point.
		const realComposed = composeForSend(buildComposeInput(realSend));
		expect(realComposed.transformConfig?.trackingPixelUrl).toBeDefined();
	});

	it('drops every tracking/site URL the tracked send carries', () => {
		expect(shadow.trackingBaseUrl).toBeUndefined();
		expect(shadow.convexSiteUrl).toBeUndefined();
		expect(shadow.siteUrl).toBeUndefined();
		expect(shadow.viewInBrowserUrl).toBeUndefined();
	});

	it('keeps the campaign attribution needed for Feedback-ID without becoming countable', () => {
		// campaignId is composition input (Feedback-ID); emailSendId is what makes
		// a Send countable. Keeping the first and dropping the second is exactly
		// what "identical mail, uncounted" means.
		expect(shadow.campaignId).toBe(CAMPAIGN_ID);
		expect(shadow.emailSendId).toBeUndefined();
	});
});
