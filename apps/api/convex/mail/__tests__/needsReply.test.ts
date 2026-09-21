/**
 * Pure-helper coverage for the Reply Queue base screen
 * (mail/needsReplyHeuristic.ts evaluateNeedsReplyCandidate /
 * isBulkOrNoReplySender / the automation screens) and the LLM dueHint
 * normalizer (mail/ai/needsReplyClassify.ts).
 */
import { describe, it, expect } from 'vitest';
import {
	evaluateNeedsReplyCandidate,
	isBulkOrNoReplySender,
	isInformationalSubject,
	isPublishingAddress,
	isUnattendedAddress,
	type NeedsReplyMessageInput,
} from '../needsReplyHeuristic';
import { normalizeDueHint, normalizeMeetingIntent } from '../ai/replyIntent';
import { isCalendarAttachment } from '../needsReply';

const OWNER = 'me@example.com';

function msg(overrides: Partial<NeedsReplyMessageInput> = {}): NeedsReplyMessageInput {
	return {
		fromAddress: 'alice@example.com',
		toAddresses: [OWNER],
		ccAddresses: [],
		hasListUnsubscribe: false,
		isFromOwner: false,
		receivedAt: 1000,
		subject: 'Quick question about the invoice',
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

	it('does not flag machine-generated mail (Auto-Submitted)', () => {
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [msg()],
			autoSubmitted: 'auto-generated',
		});
		expect(result).toEqual({ candidate: false, reason: 'automated' });
	});

	it('still flags a human message that explicitly says Auto-Submitted: no', () => {
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [msg()],
			autoSubmitted: 'no',
		});
		expect(result.candidate).toBe(true);
	});

	it('does not flag mailing-list traffic (List-Id)', () => {
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [msg()],
			listId: '<dev.lists.example>',
		});
		expect(result).toEqual({ candidate: false, reason: 'automated' });
	});

	it('does not flag a meeting-notes robot, headers or not', () => {
		// The reported bug: Gemini's notes mail landed in the queue as "Needs
		// you" and was offered a draft reply, because the recap listed to-dos.
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [
				msg({
					fromAddress: 'gemini-notes@google.com',
					subject: "Notes: 'Tech Jour Fixe' 18 Sept 2026",
				}),
			],
		});
		expect(result).toEqual({ candidate: false, reason: 'automated' });
	});

	it('still flags a person at a publishing address who actually asks something', () => {
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [
				msg({ fromAddress: 'team-notes@partner.example', subject: 'Can you review this?' }),
			],
		});
		expect(result.candidate).toBe(true);
	});

	it('still flags a colleague sending meeting notes from their own address', () => {
		// Subject alone is not enough: a human sending notes may well want a reply.
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [msg({ fromAddress: 'alice@example.com', subject: 'Notes from today' })],
		});
		expect(result.candidate).toBe(true);
	});

	it('does not flag a message whose Reply-To points at a no-reply mailbox', () => {
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [msg({ replyToAddress: 'no-reply@example.com' })],
		});
		expect(result).toEqual({ candidate: false, reason: 'bulk_sender' });
	});

	it('evaluates the LATEST inbound message, not an older personal one', () => {
		// Older personal mail, then a newer newsletter in the same thread: the
		// newest inbound is bulk, so nothing needs a reply.
		const result = evaluateNeedsReplyCandidate({
			ownerAddresses: [OWNER],
			messages: [msg({ receivedAt: 1000 }), msg({ receivedAt: 2000, hasListUnsubscribe: true })],
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
			})
		).toBe(true);
	});

	it('does not treat a person whose name contains "reply" as bulk', () => {
		expect(
			isBulkOrNoReplySender({ fromAddress: 'replyn@example.com', hasListUnsubscribe: false })
		).toBe(false);
	});

	it('catches a no-reply marker buried in a compound local part', () => {
		for (const from of [
			'drive-shares-noreply@google.com',
			'no.reply@bank.example',
			'do_not_reply@shop.example',
			'github-notifications@github.example',
		]) {
			expect(isBulkOrNoReplySender({ fromAddress: from, hasListUnsubscribe: false })).toBe(true);
		}
	});
});

describe('isUnattendedAddress', () => {
	it('matches unattended mailboxes and leaves people alone', () => {
		expect(isUnattendedAddress('noreply+orders@shop.example')).toBe(true);
		expect(isUnattendedAddress('team-alerts@ci.example')).toBe(true);
		expect(isUnattendedAddress('MAILER-DAEMON@mx.example')).toBe(true);
		expect(isUnattendedAddress('botanist@garden.example')).toBe(false);
		expect(isUnattendedAddress('updated.marcus@example.com')).toBe(false);
	});
});

describe('isPublishingAddress', () => {
	it('recognises addresses that publish rather than converse', () => {
		expect(isPublishingAddress('gemini-notes@google.com')).toBe(true);
		expect(isPublishingAddress('weekly.digest@example.com')).toBe(true);
		expect(isPublishingAddress('alice@example.com')).toBe(false);
	});
});

describe('isInformationalSubject', () => {
	it('matches records of something that already happened', () => {
		for (const subject of [
			"Notes: 'Tech Jour Fixe' 18 Sept 2026",
			'Re: Minutes from Monday',
			'Meeting notes — product sync',
			'Notizen: Wochenplanung',
			'Recap of the launch review',
		]) {
			expect(isInformationalSubject(subject)).toBe(true);
		}
	});

	it('does not match a subject that asks for something', () => {
		for (const subject of [
			'Summary needed — can you send yours?',
			'Quick question about the notes',
			'Notes: did you see the second item?',
			'Invoice 4711',
			undefined,
		]) {
			expect(isInformationalSubject(subject)).toBe(false);
		}
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

describe('isCalendarAttachment', () => {
	it('matches text/calendar and .ics filenames', () => {
		expect(
			isCalendarAttachment({ filename: 'invite.ics', contentType: 'application/octet-stream' })
		).toBe(true);
		expect(isCalendarAttachment({ filename: 'meeting', contentType: 'text/calendar' })).toBe(true);
		expect(isCalendarAttachment({ filename: 'photo.png', contentType: 'image/png' })).toBe(false);
	});
});

describe('normalizeMeetingIntent', () => {
	const intent = {
		isScheduling: true,
		proposedTimes: ['Tuesday afternoon', ' Wednesday 3pm '],
		topic: '  quarterly review  ',
	};

	it('round-trips a scheduling intent, trimming times and topic', () => {
		expect(normalizeMeetingIntent(intent, { hasCalendarInvite: false })).toEqual({
			isScheduling: true,
			proposedTimes: ['Tuesday afternoon', 'Wednesday 3pm'],
			topic: 'quarterly review',
		});
	});

	it('drops empty proposed-time phrases and caps the list', () => {
		const many = {
			isScheduling: true,
			proposedTimes: ['a', '', '   ', 'b', 'c', 'd', 'e', 'f', 'g'],
			topic: null,
		};
		const result = normalizeMeetingIntent(many, { hasCalendarInvite: false });
		expect(result?.proposedTimes).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
		expect(result?.topic).toBeUndefined();
	});

	it('excludes messages that already carry a calendar invite (.ics owns it)', () => {
		expect(normalizeMeetingIntent(intent, { hasCalendarInvite: true })).toBeUndefined();
	});

	it('returns undefined when not scheduling or no intent', () => {
		expect(
			normalizeMeetingIntent(
				{ isScheduling: false, proposedTimes: [], topic: null },
				{ hasCalendarInvite: false }
			)
		).toBeUndefined();
		expect(normalizeMeetingIntent(null, { hasCalendarInvite: false })).toBeUndefined();
	});
});
