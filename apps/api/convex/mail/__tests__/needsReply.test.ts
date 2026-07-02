/**
 * Pure-helper coverage for the Reply Queue base heuristic
 * (mail/needsReply.ts evaluateNeedsReplyCandidate / isBulkOrNoReplySender)
 * and the LLM dueHint normalizer (mail/needsReplyClassify.ts).
 */
import { describe, it, expect } from 'vitest';
import {
	evaluateNeedsReplyCandidate,
	isBulkOrNoReplySender,
	type NeedsReplyMessageInput,
} from '../needsReply';
import { normalizeDueHint } from '../needsReplyClassify';

const OWNER = 'me@example.com';

function msg(overrides: Partial<NeedsReplyMessageInput> = {}): NeedsReplyMessageInput {
	return {
		fromAddress: 'alice@example.com',
		toAddresses: [OWNER],
		ccAddresses: [],
		hasListUnsubscribe: false,
		isFromOwner: false,
		receivedAt: 1000,
		...overrides,
	};
}

describe('evaluateNeedsReplyCandidate', () => {
	it('flags an inbound message addressed to the owner in To', () => {
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [msg()],
		});
		expect(result).toEqual({ candidate: true, latestInboundIndex: 0 });
	});

	it('is case-insensitive on the To match', () => {
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [msg({ toAddresses: ['Me@Example.COM'] })],
		});
		expect(result.candidate).toBe(true);
	});

	it('does not flag when the owner is only Cc-ed', () => {
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [msg({ toAddresses: ['other@example.com'], ccAddresses: [OWNER] })],
		});
		expect(result).toEqual({ candidate: false, reason: 'not_in_to' });
	});

	it('does not flag when the owner sent a later message in the thread', () => {
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [
				msg({ receivedAt: 1000 }),
				msg({
					fromAddress: OWNER,
					toAddresses: ['alice@example.com'],
					isFromOwner: true,
					receivedAt: 2000,
				}),
			],
		});
		expect(result).toEqual({ candidate: false, reason: 'owner_replied' });
	});

	it('flags again when a newer inbound arrives after the owner reply', () => {
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [
				msg({ receivedAt: 1000 }),
				msg({ fromAddress: OWNER, isFromOwner: true, receivedAt: 2000 }),
				msg({ receivedAt: 3000 }),
			],
		});
		expect(result).toEqual({ candidate: true, latestInboundIndex: 2 });
	});

	it('recognizes owner messages by outbound marker even under an alias From', () => {
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [
				msg({ receivedAt: 1000 }),
				msg({ fromAddress: 'alias@example.com', isFromOwner: true, receivedAt: 2000 }),
			],
		});
		expect(result).toEqual({ candidate: false, reason: 'owner_replied' });
	});

	it('does not flag no-reply senders', () => {
		for (const from of [
			'no-reply@shop.example',
			'noreply@shop.example',
			'donotreply@shop.example',
			'mailer-daemon@mx.example',
			'notifications@github.example',
		]) {
			const result = evaluateNeedsReplyCandidate({
				ownerAddresses: [OWNER],
				messages: [msg({ fromAddress: from })],
			});
			expect(result).toEqual({ candidate: false, reason: 'bulk_sender' });
		}
	});

	it('does not flag list mail (List-Unsubscribe present)', () => {
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [msg({ hasListUnsubscribe: true })],
		});
		expect(result).toEqual({ candidate: false, reason: 'bulk_sender' });
	});

	it('does not flag Precedence: bulk mail (ingest-time header)', () => {
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [msg()],
			precedence: 'Bulk',
		});
		expect(result).toEqual({ candidate: false, reason: 'bulk_sender' });
	});

	it('does not flag a thread with no inbound messages (sent-only)', () => {
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [msg({ fromAddress: OWNER, isFromOwner: true })],
		});
		expect(result).toEqual({ candidate: false, reason: 'no_inbound' });
	});

	it('evaluates the LATEST inbound message, not an older personal one', () => {
		// Older personal mail, then a newer newsletter in the same thread: the
		// newest inbound is bulk, so nothing needs a reply.
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [
				msg({ receivedAt: 1000 }),
				msg({ receivedAt: 2000, hasListUnsubscribe: true }),
			],
		});
		expect(result).toEqual({ candidate: false, reason: 'bulk_sender' });
	});
});

describe('isBulkOrNoReplySender', () => {
	it('treats plus/dot suffixed no-reply local parts as bulk', () => {
		expect(
			isBulkOrNoReplySender({
				fromAddress: 'noreply+orders@shop.example',
				hasListUnsubscribe: false,
			}),
		).toBe(true);
	});

	it('does not treat a person whose name contains "reply" as bulk', () => {
		expect(
			isBulkOrNoReplySender({ fromAddress: 'replyn@example.com', hasListUnsubscribe: false }),
		).toBe(false);
	});
});

describe('normalizeDueHint', () => {
	it('keeps a valid ISO date and truncates to YYYY-MM-DD', () => {
		expect(normalizeDueHint('2026-07-04')).toBe('2026-07-04');
		expect(normalizeDueHint('2026-07-04T12:00:00Z')).toBe('2026-07-04');
	});

	it('drops null, prose, and non-ISO formats', () => {
		expect(normalizeDueHint(null)).toBeUndefined();
		expect(normalizeDueHint('next Friday')).toBeUndefined();
		expect(normalizeDueHint('07/04/2026')).toBeUndefined();
	});
});
