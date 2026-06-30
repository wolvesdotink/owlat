import { describe, it, expect } from 'vitest';
import { composeForSend, personalizeSubject } from '../index';
import { isAutomatedMail } from '../../../lib/inboundClassification';
import type { Id } from '../../../_generated/dataModel';

const CONTACT_ID = 'contact1' as Id<'contacts'>;
const SEND_ID = 'send1' as Id<'emailSends'>;
const CAMPAIGN_ID = 'campaign42' as Id<'campaigns'>;
const ORG_ID = 'org_abc123';

// Gmail FBL Feedback-ID shape: four colon-separated fields, SenderId last.
const FEEDBACK_ID_RE = /^[^:]+:[^:]+:[^:]+:[^:]+$/;

// Parse a Feedback-ID header into its four fields. Asserts the header exists
// and has exactly four segments so the rest of each test can index safely.
function feedbackFields(headers: Record<string, string>): [string, string, string, string] {
	const value = headers['Feedback-ID'];
	expect(value).toBeDefined();
	const parts = value!.split(':');
	expect(parts).toHaveLength(4);
	return [parts[0] ?? '', parts[1] ?? '', parts[2] ?? '', parts[3] ?? ''];
}

describe('composeForSend — campaign', () => {
	const baseContactInfo = {
		contactId: CONTACT_ID,
		email: 'jane@example.com',
		firstName: 'Jane',
		lastName: 'Doe',
	};

	const baseTemplate = {
		subject: 'Hi {{firstName}}',
		htmlContent: '<p>Hello {{firstName}} from {{company|\'Owlat\'}}</p>',
	};

	it('topic audience: full envelope with footer + List-Unsubscribe + tracking', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: baseTemplate,
			contactInfo: baseContactInfo,
			audienceType: 'topic',
			emailSendId: SEND_ID,
			unsubscribeUrl: 'https://site.example/unsubscribe?token=u',
			preferenceUrl: 'https://site.example/preferences?token=p',
			listUnsubscribeHeader: {
				listUnsubscribe: '<https://convex.example/unsub/abc>',
				listUnsubscribePost: 'List-Unsubscribe=One-Click',
			},
			trackingBaseUrl: 'https://track.example.com',
			viewInBrowserUrl: 'https://site.example/archive?token=a',
		});

		expect(composed.subject).toBe('Hi Jane');
		expect(composed.html).toBe('<p>Hello Jane from Owlat</p>');
		expect(composed.headers).toEqual({
			Precedence: 'bulk',
			'Auto-Submitted': 'auto-generated',
			'List-Unsubscribe': '<https://convex.example/unsub/abc>',
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
		});
		expect(composed.attachmentRefs).toEqual([]);
		expect(composed.transformConfig).toEqual({
			viewInBrowserUrl: 'https://site.example/archive?token=a',
			unsubscribeUrl: 'https://site.example/unsubscribe?token=u',
			preferenceUrl: 'https://site.example/preferences?token=p',
			trackingPixelUrl: 'https://track.example.com/t/o/send1',
			trackedLinkBase: { siteUrl: 'https://track.example.com', emailSendId: SEND_ID },
		});
	});

	it('segment audience: emits List-Unsubscribe header but no in-body footer', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: baseTemplate,
			contactInfo: baseContactInfo,
			audienceType: 'segment',
			emailSendId: SEND_ID,
			unsubscribeUrl: 'https://site.example/unsubscribe?token=u',
			preferenceUrl: 'https://site.example/preferences?token=p',
			listUnsubscribeHeader: {
				listUnsubscribe: '<https://convex.example/unsub/abc>',
				listUnsubscribePost: 'List-Unsubscribe=One-Click',
			},
			trackingBaseUrl: 'https://track.example.com',
		});

		// Gmail/Yahoo 2024 bulk rule: segment blasts MUST still carry the
		// List-Unsubscribe header. The one-click endpoint removes by contactId
		// across all topics, so it is valid for a computed segment. They are also
		// bulk, machine-generated mail (Precedence: bulk + Auto-Submitted).
		expect(composed.headers).toEqual({
			Precedence: 'bulk',
			'Auto-Submitted': 'auto-generated',
			'List-Unsubscribe': '<https://convex.example/unsub/abc>',
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
		});
		// The in-body footer stays topic-only (no single topic to render).
		expect(composed.transformConfig).toMatchObject({
			trackingPixelUrl: 'https://track.example.com/t/o/send1',
			trackedLinkBase: { siteUrl: 'https://track.example.com', emailSendId: SEND_ID },
		});
		expect(composed.transformConfig?.unsubscribeUrl).toBeUndefined();
		expect(composed.transformConfig?.preferenceUrl).toBeUndefined();
	});

	it('segment audience without a supplied header emits no List-Unsubscribe', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: baseTemplate,
			contactInfo: baseContactInfo,
			audienceType: 'segment',
			emailSendId: SEND_ID,
		});
		// No List-Unsubscribe (none supplied), but still bulk machine-generated.
		expect(composed.headers).toEqual({
			Precedence: 'bulk',
			'Auto-Submitted': 'auto-generated',
		});
	});

	it('returns null transformConfig when no transformations apply', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: baseTemplate,
			contactInfo: baseContactInfo,
		});
		expect(composed.transformConfig).toBeNull();
	});

	it('html body uses html escaping', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: {
				subject: 'Hi {{firstName}}',
				htmlContent: '<p>Hi {{firstName}}</p>',
			},
			contactInfo: { ...baseContactInfo, firstName: '<script>alert(1)</script>' },
		});

		expect(composed.html).toContain('&lt;script&gt;');
		expect(composed.html).not.toContain('<script>');
	});

	it('subject uses plain (no-escape) policy — recipients see literal characters', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: { subject: 'Hi {{firstName}}', htmlContent: '<p></p>' },
			contactInfo: { ...baseContactInfo, firstName: 'A & B' },
		});
		expect(composed.subject).toBe('Hi A & B');
	});

	it('uses fallback for missing variable in html', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: { subject: 's', htmlContent: "<p>{{company|'Acme'}}</p>" },
			contactInfo: { email: 'a@b' },
		});
		expect(composed.html).toBe('<p>Acme</p>');
	});

	// PR-51 (RFC 2046 §5.1.4): the text/plain alternative must be derived from
	// the UNTRACKED composer html. The tracking pixel + link rewriting happen
	// later in the Node `transformHtml` half, so the composer's `text` must
	// never carry the open-tracking pixel URL or a /t/c/ redirect link.
	it('emits a clean text/plain alternative that excludes the tracking-pixel URL', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: {
				subject: 'Hi {{firstName}}',
				htmlContent: '<body><p>Hello {{firstName}}</p><a href="https://shop.example/sale">Shop the sale</a></body>',
			},
			contactInfo: baseContactInfo,
			audienceType: 'topic',
			emailSendId: SEND_ID,
			trackingBaseUrl: 'https://track.example.com',
		});

		// The tracking config is present (pixel + tracked-link base) on the
		// composer output, proving the html WOULD be tracked downstream …
		expect(composed.transformConfig?.trackingPixelUrl).toBe(
			'https://track.example.com/t/o/send1',
		);
		// … yet the text part is clean: no pixel URL, no /t/c/ redirect, no <img>.
		expect(composed.text).not.toContain('/t/o/');
		expect(composed.text).not.toContain('track.example.com');
		expect(composed.text).not.toContain('/t/c/');
		expect(composed.text).not.toContain('<img');
		// It still carries the real content (personalized text + original link).
		expect(composed.text).toContain('Hello Jane');
		expect(composed.text).toContain('Shop the sale');
	});
});

describe('composeForSend — campaign List-Id (RFC 2919)', () => {
	const baseContactInfo = {
		contactId: CONTACT_ID,
		email: 'jane@example.com',
		firstName: 'Jane',
	};
	const baseTemplate = { subject: 's', htmlContent: '<p></p>' };

	// RFC 2919: optional quoted phrase, then `<list-label "." domain>` where
	// both sides of the join are dot-atom-text (no spaces, no boundary/double
	// dots). Matches the WHOLE header value.
	const DOT_ATOM = String.raw`[A-Za-z0-9!#$%&'*+/=?^_\`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_\`{|}~-]+)*`;
	const LIST_ID_RE = new RegExp(`^(?:"(?:[^"\\\\]|\\\\.)*" )?<${DOT_ATOM}>$`);

	it('topic campaign with a listId input → headers[List-Id] matches the RFC 2919 grammar', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: baseTemplate,
			contactInfo: baseContactInfo,
			audienceType: 'topic',
			listId: '"Acme Newsletter" <topic-k1234abcd.mail.acme.com>',
		});

		const listId = composed.headers['List-Id'];
		expect(listId).toBeDefined();
		expect(listId).toMatch(LIST_ID_RE);
		expect(listId).toBe('"Acme Newsletter" <topic-k1234abcd.mail.acme.com>');
		// The bracketed identifier carries no spaces.
		const bracket = listId!.slice(listId!.lastIndexOf('<') + 1, listId!.lastIndexOf('>'));
		expect(bracket).not.toMatch(/\s/);
	});

	it('omits List-Id when none is supplied (e.g. segment campaigns)', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: baseTemplate,
			contactInfo: baseContactInfo,
			audienceType: 'segment',
		});
		expect(composed.headers['List-Id']).toBeUndefined();
	});
});

describe('composeForSend — campaign Feedback-ID (Gmail FBL)', () => {
	const baseContactInfo = {
		contactId: CONTACT_ID,
		email: 'jane@example.com',
		firstName: 'Jane',
	};
	const baseTemplate = { subject: 's', htmlContent: '<p></p>' };

	it('emits a Gmail-format Feedback-ID with campaignId in field 2 and a stable senderid in field 4', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: baseTemplate,
			contactInfo: baseContactInfo,
			audienceType: 'topic',
			emailSendId: SEND_ID,
			campaignId: CAMPAIGN_ID,
			organizationId: ORG_ID,
		});

		const feedbackId = composed.headers['Feedback-ID'];
		expect(feedbackId).toMatch(FEEDBACK_ID_RE);

		const fields = feedbackFields(composed.headers);
		// field 2 carries the campaignId
		expect(fields[1]).toBe(String(CAMPAIGN_ID));
		// field 4 is the SenderId — non-empty and Gmail's 5–15 char range
		expect(fields[3].length).toBeGreaterThanOrEqual(5);
		expect(fields[3].length).toBeLessThanOrEqual(15);
		// whole header stays within Gmail's 127-byte cap
		expect(new TextEncoder().encode(feedbackId!).length).toBeLessThanOrEqual(127);
	});

	it('field 1 is the `campaign` stream token', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: baseTemplate,
			contactInfo: baseContactInfo,
			audienceType: 'topic',
			campaignId: CAMPAIGN_ID,
			organizationId: ORG_ID,
		});
		expect(feedbackFields(composed.headers)[0]).toBe('campaign');
	});

	it('the senderid is STABLE across sends from the same organization', () => {
		const sendForCampaign = (campaignId: Id<'campaigns'>): string =>
			feedbackFields(
				composeForSend({
					kind: 'campaign',
					template: baseTemplate,
					contactInfo: baseContactInfo,
					audienceType: 'topic',
					campaignId,
					organizationId: ORG_ID,
				}).headers,
			)[3];
		// Same org, different campaigns → identical SenderId anchor.
		expect(sendForCampaign(CAMPAIGN_ID)).toBe(
			sendForCampaign('campaign99' as Id<'campaigns'>),
		);
	});

	it('different organizations yield different senderids', () => {
		const senderFor = (organizationId: string): string =>
			feedbackFields(
				composeForSend({
					kind: 'campaign',
					template: baseTemplate,
					contactInfo: baseContactInfo,
					audienceType: 'topic',
					campaignId: CAMPAIGN_ID,
					organizationId,
				}).headers,
			)[3];
		expect(senderFor('org_one')).not.toBe(senderFor('org_two'));
	});

	it('omits Feedback-ID when no organizationId anchor is present', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: baseTemplate,
			contactInfo: baseContactInfo,
			audienceType: 'topic',
			campaignId: CAMPAIGN_ID,
		});
		expect(composed.headers['Feedback-ID']).toBeUndefined();
	});

	it('stays within 127 bytes even for a long campaignId', () => {
		const longCampaignId = ('c'.repeat(200)) as Id<'campaigns'>;
		const composed = composeForSend({
			kind: 'campaign',
			template: baseTemplate,
			contactInfo: baseContactInfo,
			audienceType: 'topic',
			campaignId: longCampaignId,
			organizationId: ORG_ID,
		});
		const fields = feedbackFields(composed.headers);
		expect(
			new TextEncoder().encode(composed.headers['Feedback-ID']!).length,
		).toBeLessThanOrEqual(127);
		// The SenderId anchor (last field) is preserved despite trimming.
		expect(fields[3].length).toBeGreaterThanOrEqual(5);
	});

	it('segment audience tags field 3 with the audience type', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: baseTemplate,
			contactInfo: baseContactInfo,
			audienceType: 'segment',
			campaignId: CAMPAIGN_ID,
			organizationId: ORG_ID,
		});
		expect(feedbackFields(composed.headers)[2]).toBe('segment');
	});
});

describe('composeForSend — transactional', () => {
	it('personalizes against dataVariables', () => {
		const composed = composeForSend({
			kind: 'transactional',
			template: {
				subject: 'Order {{orderId}}',
				htmlContent: '<p>Thanks {{name}}, your total is {{total}}</p>',
			},
			dataVariables: { orderId: '12345', name: 'Jane', total: 99 },
		});

		expect(composed.subject).toBe('Order 12345');
		expect(composed.html).toBe('<p>Thanks Jane, your total is 99</p>');
		expect(composed.headers).toEqual({ 'Auto-Submitted': 'auto-generated' });
		expect(composed.transformConfig).toBeNull();
	});

	it('returns merged attachment refs', () => {
		const composed = composeForSend({
			kind: 'transactional',
			template: { subject: 's', htmlContent: '<p></p>' },
			attachmentRefs: [
				{ filename: 'invoice.pdf', url: 'https://storage/invoice.pdf' },
			],
		});
		expect(composed.attachmentRefs).toEqual([
			{ filename: 'invoice.pdf', url: 'https://storage/invoice.pdf' },
		]);
	});

	it('html body uses html escaping for dataVariables values', () => {
		const composed = composeForSend({
			kind: 'transactional',
			template: { subject: 's', htmlContent: '<p>{{userInput}}</p>' },
			dataVariables: { userInput: '<script>alert(1)</script>' },
		});
		expect(composed.html).toContain('&lt;script&gt;');
	});

	it('null transformConfig — no tracking on transactional emails', () => {
		const composed = composeForSend({
			kind: 'transactional',
			template: { subject: 's', htmlContent: '<p></p>' },
			dataVariables: {},
		});
		expect(composed.transformConfig).toBeNull();
	});

	it('emits an unsubscribe footer transformConfig when both URLs are supplied', () => {
		const composed = composeForSend({
			kind: 'transactional',
			template: { subject: 's', htmlContent: '<p></p>' },
			unsubscribeUrl: 'https://site.example/unsubscribe?token=u',
			preferenceUrl: 'https://site.example/preferences?token=p',
		});
		expect(composed.transformConfig).toEqual({
			unsubscribeUrl: 'https://site.example/unsubscribe?token=u',
			preferenceUrl: 'https://site.example/preferences?token=p',
		});
	});

	it('no footer when only one of the two URLs is supplied', () => {
		const composed = composeForSend({
			kind: 'transactional',
			template: { subject: 's', htmlContent: '<p></p>' },
			unsubscribeUrl: 'https://site.example/unsubscribe?token=u',
		});
		expect(composed.transformConfig).toBeNull();
	});

	it('handles undefined dataVariables gracefully', () => {
		const composed = composeForSend({
			kind: 'transactional',
			template: { subject: 'Hi {{name}}', htmlContent: '<p>Hi {{name}}</p>' },
		});
		expect(composed.subject).toBe('Hi ');
		expect(composed.html).toBe('<p>Hi </p>');
	});

	it('no Feedback-ID header when organizationId is absent', () => {
		const composed = composeForSend({
			kind: 'transactional',
			template: { subject: 's', htmlContent: '<p></p>' },
			dataVariables: {},
		});
		expect(composed.headers['Feedback-ID']).toBeUndefined();
		// Auto-Submitted is stamped unconditionally (RFC 3834 §5); only the
		// Feedback-ID header depends on organizationId.
		expect(composed.headers).toEqual({ 'Auto-Submitted': 'auto-generated' });
	});

	// CL-01: the transactional composer is the collapse point for the agent 1:1
	// reply path. An automatic reply to a specific inbound message must stamp
	// `Auto-Submitted: auto-replied` (RFC 3834 §2), not `auto-generated`.
	it('stamps Auto-Submitted: auto-replied when autoSubmittedType is auto-replied', () => {
		const composed = composeForSend({
			kind: 'transactional',
			template: { subject: 'Re: Hi', htmlContent: '<p>Re: Hi</p>' },
			autoSubmittedType: 'auto-replied',
		});
		expect(composed.headers['Auto-Submitted']).toBe('auto-replied');
		// Still loop-safe — `auto-replied` is `!= no`.
		expect(isAutomatedMail(composed.headers)).toBe(true);
		// A 1:1 reply must never carry a List-Unsubscribe header.
		expect(composed.headers['List-Unsubscribe']).toBeUndefined();
		expect(composed.headers['List-Unsubscribe-Post']).toBeUndefined();
	});

	it('defaults Auto-Submitted to auto-generated when autoSubmittedType is omitted', () => {
		const composed = composeForSend({
			kind: 'transactional',
			template: { subject: 's', htmlContent: '<p></p>' },
		});
		expect(composed.headers['Auto-Submitted']).toBe('auto-generated');
	});

	it('honors an explicit auto-generated autoSubmittedType', () => {
		const composed = composeForSend({
			kind: 'transactional',
			template: { subject: 's', htmlContent: '<p></p>' },
			autoSubmittedType: 'auto-generated',
		});
		expect(composed.headers['Auto-Submitted']).toBe('auto-generated');
	});
});

describe('composeForSend — transactional Feedback-ID (Gmail FBL)', () => {
	it('emits a `txn`-stream Feedback-ID — a DISTINCT stream token from campaign', () => {
		const txn = composeForSend({
			kind: 'transactional',
			template: { subject: 's', htmlContent: '<p></p>' },
			dataVariables: {},
			organizationId: ORG_ID,
		});
		expect(txn.headers['Feedback-ID']).toMatch(FEEDBACK_ID_RE);

		const txnFields = feedbackFields(txn.headers);
		expect(txnFields[0]).toBe('txn');

		// The campaign composer uses a DIFFERENT stream token for the SAME org —
		// transactional / automation complaints aggregate in their own bucket.
		const campaign = composeForSend({
			kind: 'campaign',
			template: { subject: 's', htmlContent: '<p></p>' },
			contactInfo: { email: 'x@y' },
			audienceType: 'topic',
			campaignId: CAMPAIGN_ID,
			organizationId: ORG_ID,
		});
		const campaignFields = feedbackFields(campaign.headers);
		expect(campaignFields[0]).toBe('campaign');
		expect(txnFields[0]).not.toBe(campaignFields[0]);
		// ...but the SenderId anchor (field 4) is shared per organization.
		expect(txnFields[3]).toBe(campaignFields[3]);
	});

	it('stays within Gmail constraints (4 fields, <=127 bytes, 5–15 char SenderId)', () => {
		const composed = composeForSend({
			kind: 'transactional',
			template: { subject: 's', htmlContent: '<p></p>' },
			organizationId: ORG_ID,
		});
		const fields = feedbackFields(composed.headers);
		expect(fields[3].length).toBeGreaterThanOrEqual(5);
		expect(fields[3].length).toBeLessThanOrEqual(15);
		expect(
			new TextEncoder().encode(composed.headers['Feedback-ID']!).length,
		).toBeLessThanOrEqual(127);
	});
});

describe('composeForSend — test', () => {
	it('personalizes against sampleContact', () => {
		const composed = composeForSend({
			kind: 'test',
			template: { subject: 'Hi {{firstName}}', htmlContent: '<p>Hello {{firstName}}</p>' },
			sampleContact: { email: 'test@example.com', firstName: 'Test', lastName: 'User' },
		});

		expect(composed.subject).toBe('Hi Test');
		expect(composed.html).toBe('<p>Hello Test</p>');
		expect(composed.headers).toEqual({});
		expect(composed.attachmentRefs).toEqual([]);
		expect(composed.transformConfig).toBeNull();
	});

	it('uses custom variables (extension fields on sampleContact)', () => {
		const composed = composeForSend({
			kind: 'test',
			template: { subject: 'Order {{orderId}}', htmlContent: '<p>{{orderId}}</p>' },
			sampleContact: { email: 'x@y', firstName: 'a', orderId: 'XYZ' },
		});
		expect(composed.subject).toBe('Order XYZ');
		expect(composed.html).toBe('<p>XYZ</p>');
	});

	it('html body uses html escaping', () => {
		const composed = composeForSend({
			kind: 'test',
			template: { subject: 's', htmlContent: '<p>{{firstName}}</p>' },
			sampleContact: { email: 'x@y', firstName: '<b>X</b>' },
		});
		expect(composed.html).toContain('&lt;b&gt;');
	});
});

describe('composeForSend — archive_snapshot', () => {
	it('subject passed through raw, html personalized against empty placeholder', () => {
		const composed = composeForSend({
			kind: 'archive_snapshot',
			template: {
				subject: 'Newsletter for {{firstName}}',
				htmlContent: '<p>Hi {{firstName}}, from {{company|\'Owlat\'}}</p>',
			},
		});

		expect(composed.subject).toBe('Newsletter for {{firstName}}');
		expect(composed.html).toBe('<p>Hi , from Owlat</p>');
		expect(composed.headers).toEqual({});
		expect(composed.transformConfig).toBeNull();
	});

	it('handles templates without variables', () => {
		const composed = composeForSend({
			kind: 'archive_snapshot',
			template: { subject: 'Hello', htmlContent: '<p>Static content</p>' },
		});

		expect(composed.subject).toBe('Hello');
		expect(composed.html).toBe('<p>Static content</p>');
	});
});

describe('composeForSend — automation', () => {
	it('personalizes against contactInfo, no tracking', () => {
		const composed = composeForSend({
			kind: 'automation',
			template: { subject: 'Hi {{firstName}}', htmlContent: '<p>Hello {{firstName}}</p>' },
			contactInfo: { email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe' },
		});

		expect(composed.subject).toBe('Hi Jane');
		expect(composed.html).toBe('<p>Hello Jane</p>');
		expect(composed.headers).toEqual({ 'Auto-Submitted': 'auto-generated' });
		expect(composed.attachmentRefs).toEqual([]);
		expect(composed.transformConfig).toBeNull();
	});

	it('html body uses html escaping', () => {
		const composed = composeForSend({
			kind: 'automation',
			template: { subject: 's', htmlContent: '<p>{{firstName}}</p>' },
			contactInfo: { email: 'x@y', firstName: '<script>x</script>' },
		});
		expect(composed.html).toContain('&lt;script&gt;');
	});

	it('emits List-Unsubscribe header for marketing steps when supplied', () => {
		const composed = composeForSend({
			kind: 'automation',
			template: { subject: 'Hi {{firstName}}', htmlContent: '<p>Hello {{firstName}}</p>' },
			contactInfo: { email: 'jane@example.com', firstName: 'Jane' },
			listUnsubscribeHeader: {
				listUnsubscribe: '<https://convex.example/unsub/abc>',
				listUnsubscribePost: 'List-Unsubscribe=One-Click',
			},
		});

		// Automation mail always carries Auto-Submitted (RFC 3834 §5); marketing
		// steps additionally carry the supplied List-Unsubscribe header.
		expect(composed.headers).toEqual({
			'Auto-Submitted': 'auto-generated',
			'List-Unsubscribe': '<https://convex.example/unsub/abc>',
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
		});
		expect(composed.transformConfig).toBeNull();
	});

	it('no List-Unsubscribe header when the input omits it', () => {
		const composed = composeForSend({
			kind: 'automation',
			template: { subject: 's', htmlContent: '<p></p>' },
			contactInfo: { email: 'x@y' },
		});
		// Still bulk machine-generated mail (Auto-Submitted), just no unsubscribe.
		expect(composed.headers).toEqual({ 'Auto-Submitted': 'auto-generated' });
	});
});

describe('composeForSend — Auto-Submitted / Precedence anti-loop headers (RFC 3834 §5, RFC 2076)', () => {
	const template = { subject: 's', htmlContent: '<p></p>' };

	it('transactional carries Auto-Submitted: auto-generated', () => {
		const composed = composeForSend({
			kind: 'transactional',
			template,
			dataVariables: {},
		});
		expect(composed.headers['Auto-Submitted']).toBe('auto-generated');
		expect(isAutomatedMail(composed.headers)).toBe(true);
	});

	it('automation carries Auto-Submitted: auto-generated', () => {
		const composed = composeForSend({
			kind: 'automation',
			template,
			contactInfo: { email: 'jane@example.com', firstName: 'Jane' },
		});
		expect(composed.headers['Auto-Submitted']).toBe('auto-generated');
		expect(isAutomatedMail(composed.headers)).toBe(true);
	});

	it('campaign carries Precedence: bulk + Auto-Submitted + List-Unsubscribe', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template,
			contactInfo: { email: 'jane@example.com', firstName: 'Jane' },
			audienceType: 'topic',
			unsubscribeUrl: 'https://site.example/unsubscribe?token=u',
			preferenceUrl: 'https://site.example/preferences?token=p',
			listUnsubscribeHeader: {
				listUnsubscribe: '<https://convex.example/unsub/abc>',
				listUnsubscribePost: 'List-Unsubscribe=One-Click',
			},
		});
		expect(composed.headers['Precedence']).toBe('bulk');
		expect(composed.headers['Auto-Submitted']).toBe('auto-generated');
		expect(composed.headers['List-Unsubscribe']).toBe('<https://convex.example/unsub/abc>');
		// Either Precedence: bulk or Auto-Submitted alone is enough for the
		// receiving Owlat instance to suppress an auto-reply.
		expect(isAutomatedMail(composed.headers)).toBe(true);
	});

	it('segment campaign (no List-Unsubscribe) is still classified automated', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template,
			contactInfo: { email: 'jane@example.com', firstName: 'Jane' },
			audienceType: 'segment',
		});
		expect(composed.headers['Precedence']).toBe('bulk');
		expect(composed.headers['Auto-Submitted']).toBe('auto-generated');
		expect(composed.headers['List-Unsubscribe']).toBeUndefined();
		expect(isAutomatedMail(composed.headers)).toBe(true);
	});
});

describe('personalizeSubject', () => {
	it('campaign: uses contactInfo', () => {
		expect(
			personalizeSubject({
				kind: 'campaign',
				template: { subject: 'Hi {{firstName}}', htmlContent: '' },
				contactInfo: { email: 'jane@x', firstName: 'Jane' },
			}),
		).toBe('Hi Jane');
	});

	it('transactional: uses dataVariables', () => {
		expect(
			personalizeSubject({
				kind: 'transactional',
				template: { subject: 'Order {{id}}', htmlContent: '' },
				dataVariables: { id: 'A1' },
			}),
		).toBe('Order A1');
	});

	it('test: uses sampleContact', () => {
		expect(
			personalizeSubject({
				kind: 'test',
				template: { subject: 'Hi {{firstName}}', htmlContent: '' },
				sampleContact: { email: 't@x', firstName: 'T' },
			}),
		).toBe('Hi T');
	});

	it('archive_snapshot: empty placeholder (passes through subject template raw)', () => {
		expect(
			personalizeSubject({
				kind: 'archive_snapshot',
				template: { subject: "Hi {{firstName|'friend'}}", htmlContent: '' },
			}),
		).toBe('Hi friend');
	});

	it('automation: uses contactInfo', () => {
		expect(
			personalizeSubject({
				kind: 'automation',
				template: { subject: 'Hi {{firstName}}', htmlContent: '' },
				contactInfo: { email: 'x@y', firstName: 'X' },
			}),
		).toBe('Hi X');
	});

	it('always uses plain escape — does not html-escape the subject', () => {
		expect(
			personalizeSubject({
				kind: 'campaign',
				template: { subject: 'Hi {{firstName}}', htmlContent: '' },
				contactInfo: { email: 'x@y', firstName: 'A & B' },
			}),
		).toBe('Hi A & B');
	});
});
