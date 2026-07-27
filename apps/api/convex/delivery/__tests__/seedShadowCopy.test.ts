/**
 * (b) The seed shadow copy goes through the IDENTICAL composer and the
 * IDENTICAL transport, carries the probe id, clears the worker's pre-dispatch
 * gates, and is EXCLUDED from analytics and reputation denominators (D18).
 *
 * The secret is set at MODULE scope, before any `describe` body runs: vitest
 * executes describe bodies at collection time, so a `beforeAll` would be too
 * late for the composition performed there and the whole file would fail to
 * collect (which is exactly what happened in review round 1).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { buildSeedShadowEnvelope, isSeedShadowEnvelope } from '../seedShadowCopy';
import type { CampaignEnvelopeInput } from '../seedShadowCopy';
import { assertSeedShadowExclusion, buildComposeInput } from '../worker';
import { assertMarketingOneClickHeaders } from '../marketingCompliance';
import { composeForSend } from '../sendComposition';
import { SEED_PROBE_HEADER } from '@owlat/shared/seedPlacement';
import type { Id } from '../../_generated/dataModel';

const PREV_SECRET = process.env['UNSUBSCRIBE_SECRET'];
process.env['UNSUBSCRIBE_SECRET'] = 'test-unsubscribe-secret';

afterAll(() => {
	if (PREV_SECRET === undefined) delete process.env['UNSUBSCRIBE_SECRET'];
	else process.env['UNSUBSCRIBE_SECRET'] = PREV_SECRET;
});

const CONTACT_ID = 'contact1' as Id<'contacts'>;
const SEND_ID = 'send1' as Id<'emailSends'>;
const CAMPAIGN_ID = 'campaign1' as Id<'campaigns'>;
const PROBE_REF = 'probe1' as Id<'seedPlacementProbes'>;
const PROBE_ID = 'sp_abcdefghij0123456789kl';
const SEED_ADDRESS = 'owlat.seed.01@gmail.example';

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
	template: {
		subject: 'March newsletter',
		htmlContent: '<p>Hello there <a href="https://org.example/read">read</a></p>',
	},
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
	probeRef: PROBE_REF,
});

describe('buildSeedShadowEnvelope — identical transport', () => {
	it('keeps the same kind, so it goes through the same worker and composer', () => {
		expect(shadow.kind).toBe('campaign');
	});

	it('keeps every routing field that decides HOW the mail leaves', () => {
		expect(shadow.from).toBe(realSend.from);
		expect(shadow.replyTo).toBe(realSend.replyTo);
		expect(shadow.providerType).toBe(realSend.providerType);
		expect(shadow.ipPool).toBe(realSend.ipPool);
		expect(shadow.deliveryDomain).toBe(realSend.deliveryDomain);
	});

	it('addresses the seed mailbox and nobody else', () => {
		expect(shadow.to).toBe(SEED_ADDRESS);
		expect(shadow.contactInfo.email).toBe(SEED_ADDRESS);
	});

	it('never mutates the real envelope', () => {
		expect(realSend.to).toBe('jane@example.com');
		expect(realSend.seedProbeId).toBeUndefined();
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

	it('carries the SAME one-click contract, differing only in the token target', () => {
		expect(shadowOut.headers['List-Unsubscribe-Post']).toBe(
			realOut.headers['List-Unsubscribe-Post']
		);
		// A probe's target is probe-scoped: a real subscriber's one-click token
		// must never land in an operator mailbox.
		expect(shadowOut.headers['List-Unsubscribe']).not.toBe(realOut.headers['List-Unsubscribe']);
		expect(shadowOut.headers['List-Unsubscribe']).toContain('/unsub/probe/');
	});

	it('adds exactly one header and re-targets exactly one', () => {
		const differing = new Set<string>();
		for (const key of new Set([
			...Object.keys(shadowOut.headers),
			...Object.keys(realOut.headers),
		])) {
			if (shadowOut.headers[key] !== realOut.headers[key]) differing.add(key);
		}
		expect([...differing].sort()).toEqual(['List-Unsubscribe', SEED_PROBE_HEADER]);
	});

	it('carries the same wire features a filter weighs: pixel and wrapped links', () => {
		expect(shadowOut.transformConfig?.trackingPixelUrl).toBeDefined();
		expect(shadowOut.transformConfig?.trackedLinkBase).toBeDefined();
		expect(realOut.transformConfig?.trackingPixelUrl).toBeDefined();
	});
});

/** (b) A probe must clear the two pre-dispatch gates that used to throw. */
describe('dispatch path — the probe clears every pre-dispatch gate', () => {
	it('passes the marketing one-click assertion the campaign worker applies', () => {
		const composed = composeForSend(buildComposeInput(shadow));
		expect(() => assertMarketingOneClickHeaders('marketing', composed.headers)).not.toThrow();
	});

	it('passes the seed-shadow exclusion invariant, as does a real send', () => {
		expect(() => assertSeedShadowExclusion(shadow)).not.toThrow();
		expect(() => assertSeedShadowExclusion(realSend)).not.toThrow();
	});

	it('carries a durable dispatch reference, so the governed boundary accepts it', () => {
		// `governedDispatch` refuses a dispatch with no durable reference. The
		// probe supplies its ledger row instead of a Send.
		expect(shadow.seedProbeRef).toBe(PROBE_REF);
		expect(shadow.emailSendId).toBeUndefined();
	});

	it('rejects an envelope that would be both a probe and a countable Send', () => {
		expect(() => assertSeedShadowExclusion({ ...shadow, emailSendId: SEND_ID })).toThrow(
			/must not carry a countable Send/
		);
		expect(() =>
			assertSeedShadowExclusion({
				...shadow,
				contactInfo: { email: SEED_ADDRESS, contactId: CONTACT_ID },
			})
		).toThrow(/must not carry a countable Send/);
	});

	it('rejects a probe envelope with no ledger reference', () => {
		const orphan: CampaignEnvelopeInput = { ...shadow };
		delete orphan.seedProbeRef;
		expect(() => assertSeedShadowExclusion(orphan)).toThrow(/probe ledger reference/);
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

	it('tracks under the opaque probe id, never under a countable Send id', () => {
		const composed = composeForSend(buildComposeInput(shadow));
		expect(composed.transformConfig?.trackingPixelUrl).toContain(PROBE_ID);
		expect(composed.transformConfig?.trackingPixelUrl).not.toContain(SEND_ID);
		expect(composed.transformConfig?.trackedLinkBase?.emailSendId).toBe(PROBE_ID);
	});

	it('drops the contact-scoped footer and archive URLs', () => {
		expect(shadow.siteUrl).toBeUndefined();
		expect(shadow.viewInBrowserUrl).toBeUndefined();
	});

	it('keeps the campaign attribution needed for Feedback-ID without becoming countable', () => {
		expect(shadow.campaignId).toBe(CAMPAIGN_ID);
		expect(shadow.emailSendId).toBeUndefined();
	});
});
