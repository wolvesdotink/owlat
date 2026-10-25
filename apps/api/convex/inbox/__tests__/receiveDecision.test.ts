/**
 * The inbound receive's pure decisions (`inbox/receiveDecision.ts`) for fixed
 * arrivals. `inboundReceiveDispositions.integration.test.ts` and
 * `inbound.integration.test.ts` hold the live mutation to them.
 */
import { describe, expect, it } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import {
	coalesceWindowFor,
	decidePipelineStart,
	inboundMessageRow,
	planArrival,
	type Arrival,
} from '../receiveDecision';

const arrival = (overrides: Partial<Arrival> = {}): Arrival => ({
	messageId: '<m1@example.com>',
	from: '"Pat Doe" <Pat@Example.com>',
	to: 'inbox@owlat.example',
	subject: 'Re: Your order',
	textBody: 'Thanks!',
	timestamp: 1_800_000_000_000,
	...overrides,
});

describe('planArrival', () => {
	it('derives the sender, subject, first name and preview from the envelope', () => {
		expect(planArrival(arrival())).toEqual({
			senderEmail: 'pat@example.com',
			normalizedSubject: 'your order',
			senderFirstName: 'Pat',
			preview: 'Thanks!',
			isInfected: false,
			isPipelineSkipped: false,
			replyFeedbackText: undefined,
		});
	});

	it('classifies a reply from its threading headers, bounded, and never a quarantined one', () => {
		const long = 'x'.repeat(70 * 1024);
		const reply = planArrival(arrival({ inReplyTo: '<p@example.com>', textBody: long }));
		expect(reply.replyFeedbackText).toHaveLength(64 * 1024);
		expect(planArrival(arrival({ references: '<p@example.com>' })).replyFeedbackText).toBe(
			'Thanks!'
		);
		const infected = planArrival(
			arrival({ inReplyTo: '<p@example.com>', virusVerdict: 'infected' })
		);
		expect(infected).toMatchObject({
			isInfected: true,
			isPipelineSkipped: true,
			replyFeedbackText: undefined,
		});
		expect(
			planArrival(arrival({ inReplyTo: '<p@example.com>', textBody: '' })).replyFeedbackText
		).toBeUndefined();
	});

	it('skips the pipeline for automated mail, list mail and self-sends', () => {
		const skipped = (overrides: Partial<Arrival>) =>
			planArrival(arrival(overrides)).isPipelineSkipped;
		expect(skipped({ headers: JSON.stringify({ 'Auto-Submitted': 'auto-replied' }) })).toBe(true);
		expect(skipped({ headers: JSON.stringify({ 'List-Id': '<news.example.com>' }) })).toBe(true);
		expect(skipped({ from: 'Inbox <inbox@owlat.example>' })).toBe(true);
		expect(skipped({ headers: 'not json' })).toBe(false);
	});

	it('builds the preview from the html part when there is no text', () => {
		expect(
			planArrival(arrival({ textBody: undefined, htmlBody: '<p>Hello <b>there</b></p>' })).preview
		).toBe('Hello there');
	});

	it('is the same plan on every evaluation and leaves the arrival alone', () => {
		const input = Object.freeze(arrival({ inReplyTo: '<p@example.com>' }));
		expect(planArrival(input)).toEqual(planArrival(input));
	});
});

describe('inboundMessageRow', () => {
	const threadId = 'thread_1' as Id<'conversationThreads'>;
	const contactId = 'contact_1' as Id<'contacts'>;
	const rawStorageId = 'storage_1' as Id<'_storage'>;

	it('stores the envelope with the sealed body columns, received or quarantined', () => {
		const row = inboundMessageRow(arrival({ rawStorageId, rawSize: 10, dmarcResult: 'pass' }), {
			bodyColumns: { textBody: 'sealed-text' },
			threadId,
			contactId,
			isInfected: false,
		});
		expect(row).toMatchObject({
			messageId: '<m1@example.com>',
			textBody: 'sealed-text',
			threadId,
			contactId,
			processingStatus: 'received',
			receivedAt: 1_800_000_000_000,
			rawStorageId,
			isRawRetained: true,
			dmarcResult: 'pass',
		});
		expect(
			inboundMessageRow(arrival(), { bodyColumns: {}, threadId, contactId, isInfected: true })
		).toMatchObject({ processingStatus: 'quarantined', isRawRetained: undefined });
	});
});

describe('the pipeline start', () => {
	it('registers a coalesce window only when one is set and the mail is not skipped', () => {
		expect(coalesceWindowFor({ isPipelineSkipped: false }, 30_000)).toBe(30_000);
		expect(coalesceWindowFor({ isPipelineSkipped: false }, 0)).toBeUndefined();
		expect(coalesceWindowFor({ isPipelineSkipped: false }, undefined)).toBeUndefined();
		expect(coalesceWindowFor({ isPipelineSkipped: true }, 30_000)).toBeUndefined();
	});

	it('skips quarantined and automated mail, waits on a coalesce batch, else starts under the caps', () => {
		expect(decidePipelineStart({ isInfected: true, isPipelineSkipped: true }, false)).toMatchObject(
			{
				kind: 'skip',
				message: expect.stringContaining('malware found'),
			}
		);
		expect(
			decidePipelineStart({ isInfected: false, isPipelineSkipped: true }, false)
		).toMatchObject({
			kind: 'skip',
			message: expect.stringContaining('automated/self-send'),
		});
		expect(decidePipelineStart({ isInfected: false, isPipelineSkipped: false }, true)).toEqual({
			kind: 'coalesced',
		});
		expect(decidePipelineStart({ isInfected: false, isPipelineSkipped: false }, false)).toEqual({
			kind: 'start_within_caps',
		});
	});
});
