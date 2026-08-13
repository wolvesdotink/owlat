/**
 * The text/plain part of a send: the template's `plainTextContent` (the
 * author's override, else the body generated from the block document at save
 * time) wins over the html strip, is personalized WITHOUT html escaping, and
 * never carries tracking artefacts.
 */

import { describe, it, expect } from 'vitest';
import { composeForSend } from '../index';
import type { Id } from '../../../_generated/dataModel';

const CONTACT_ID = 'contact1' as Id<'contacts'>;
const SEND_ID = 'send1' as Id<'emailSends'>;

const contactInfo = {
	contactId: CONTACT_ID,
	email: 'jane@example.com',
	firstName: 'Jane',
	lastName: 'Doe',
};

describe('composeForSend — text/plain part', () => {
	it('ships the stored plain-text body instead of stripping the html', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: {
				subject: 'Hi',
				htmlContent: '<h1>Sale</h1><p>Shop <a href="https://shop.example">now</a></p>',
				plainTextContent: 'Sale\n====\n\nShop now (https://shop.example)',
			},
			contactInfo,
		});

		expect(composed.text).toBe('Sale\n====\n\nShop now (https://shop.example)');
	});

	it('falls back to the html strip when no plain-text body was stored', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: { subject: 'Hi', htmlContent: '<p>Hello</p><p>World</p>' },
			contactInfo,
		});

		expect(composed.text).toBe('Hello\n\nWorld');
	});

	it('falls back when the stored body is whitespace only', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: {
				subject: 'Hi',
				htmlContent: '<p>Hello</p>',
				plainTextContent: '   \n\t ',
			},
			contactInfo,
		});

		expect(composed.text).toBe('Hello');
	});

	it('personalizes the stored body with the contact variables', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: {
				subject: 'Hi',
				htmlContent: '<p>Hi {{firstName}}</p>',
				plainTextContent: "Hi {{firstName}}, from {{company|'Owlat'}}",
			},
			contactInfo,
		});

		expect(composed.text).toBe('Hi Jane, from Owlat');
	});

	it('does NOT html-escape substituted values in the text part', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: {
				subject: 'Hi',
				htmlContent: '<p>{{firstName}}</p>',
				plainTextContent: 'Hello {{firstName}}',
			},
			contactInfo: { ...contactInfo, firstName: 'Ben & Jerry' },
		});

		expect(composed.text).toBe('Hello Ben & Jerry');
		// The html half still escapes — the two policies are independent.
		expect(composed.html).toBe('<p>Ben &amp; Jerry</p>');
	});

	it('carries no tracking pixel or redirect link (the transform runs after composition)', () => {
		const composed = composeForSend({
			kind: 'campaign',
			template: {
				subject: 'Hi',
				htmlContent: '<p><a href="https://shop.example">Shop</a></p>',
				plainTextContent: 'Shop (https://shop.example)',
			},
			contactInfo,
			emailSendId: SEND_ID,
			trackingBaseUrl: 'https://track.example.com',
		});

		expect(composed.text).not.toContain('/t/o');
		expect(composed.text).not.toContain('/t/c');
		expect(composed.text).toContain('https://shop.example');
		// The tracking config is still produced for the html half.
		expect(composed.transformConfig?.trackingPixelUrl).toBeTruthy();
	});

	it('substitutes transactional data variables into the stored body', () => {
		const composed = composeForSend({
			kind: 'transactional',
			template: {
				subject: 'Receipt',
				htmlContent: '<p>Total {{total}}</p>',
				plainTextContent: 'Total {{total}}',
			},
			dataVariables: { total: '$42.00' },
		});

		expect(composed.text).toBe('Total $42.00');
	});

	it('substitutes the sample contact into the stored body on a test send', () => {
		const composed = composeForSend({
			kind: 'test',
			template: {
				subject: 'Preview',
				htmlContent: '<p>Hi {{firstName}}</p>',
				plainTextContent: 'Hi {{firstName}}',
			},
			sampleContact: { email: 't@example.com', firstName: 'Sam' },
		});

		expect(composed.text).toBe('Hi Sam');
	});

	it('substitutes the contact into the stored body on an automation send', () => {
		const composed = composeForSend({
			kind: 'automation',
			template: {
				subject: 'Drip',
				htmlContent: '<p>Hi {{firstName}}</p>',
				plainTextContent: 'Hi {{firstName}}',
			},
			contactInfo,
		});

		expect(composed.text).toBe('Hi Jane');
	});
});
