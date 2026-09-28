/**
 * The web's status-pill vocabulary sits on `@owlat/shared/threadStatus`:
 *   - the priority list is the shared one with the web-only states inserted,
 *     and the order is pinned so a shared change cannot silently reorder pills;
 *   - a Postbox list row is the shared derivation with no unseen messages;
 *   - a team-inbox row never claims a pill where the thread chip would say
 *     Resolved or Snoozed.
 */
import { describe, expect, it } from 'vitest';
import { THREAD_STATUS_PRIORITY, deriveThreadStatus } from '@owlat/shared/threadStatus';
import {
	CONVERSATION_STATUS_LABEL,
	CONVERSATION_STATUS_PRIORITY,
	mailThreadStatus,
	mostUrgentConversationStatus,
	teamThreadStatus,
} from '../conversationStatus';
import { threadStatusChip } from '../threadStatusChip';

describe('conversation status priority', () => {
	it('keeps the order the pills have always ranked in', () => {
		expect([...CONVERSATION_STATUS_PRIORITY]).toEqual([
			'draft_ready',
			'needs_you',
			'needs_review',
			'mentioned',
			'working',
			'updated',
			'results_in',
			'running',
			'scheduled',
			'waiting',
		]);
	});

	it('keeps the shared statuses in their shared order', () => {
		const shared = new Set<string>(THREAD_STATUS_PRIORITY);
		expect(CONVERSATION_STATUS_PRIORITY.filter((s) => shared.has(s))).toEqual([
			...THREAD_STATUS_PRIORITY,
		]);
	});

	it('ranks and labels every status exactly once', () => {
		expect(new Set(CONVERSATION_STATUS_PRIORITY).size).toBe(CONVERSATION_STATUS_PRIORITY.length);
		expect([...CONVERSATION_STATUS_PRIORITY].sort()).toEqual(
			Object.keys(CONVERSATION_STATUS_LABEL).sort()
		);
	});

	it('keeps the most urgent status', () => {
		expect(mostUrgentConversationStatus(['waiting', 'updated', 'draft_ready'])).toBe('draft_ready');
		expect(mostUrgentConversationStatus(['scheduled', 'mentioned', 'updated'])).toBe('mentioned');
		expect(mostUrgentConversationStatus([null])).toBeNull();
	});
});

describe('mailThreadStatus', () => {
	it('derives a Postbox row from the thread alone', () => {
		expect(mailThreadStatus({ needsReply: { draftSlot: {} } })).toBe('draft_ready');
		expect(mailThreadStatus({ needsReply: { clarification: { draft: {} } } })).toBe('draft_ready');
		expect(mailThreadStatus({ needsReply: {} })).toBe('needs_you');
		expect(mailThreadStatus({ followUp: { dueAt: 1 } })).toBe('needs_you');
		expect(mailThreadStatus({ followUp: {} })).toBe('waiting');
		expect(mailThreadStatus({})).toBeNull();
	});

	it('agrees with the shared derivation when nothing is unseen', () => {
		const inputs = [
			{ needsReply: { draftSlot: {} }, followUp: {} },
			{ needsReply: { clarification: null } },
			{ followUp: { dueAt: 5 } },
			{ followUp: {} },
			{ needsReply: null, followUp: null },
		];
		for (const input of inputs) {
			expect(mailThreadStatus(input)).toBe(deriveThreadStatus({ ...input, newSinceVisit: 0 }));
		}
	});
});

describe('teamThreadStatus', () => {
	const now = 1_000_000;

	it('ranks a pending draft over unread news over waiting', () => {
		expect(teamThreadStatus({ latestDraftStatus: 'pending', unread: true })).toBe('draft_ready');
		expect(teamThreadStatus({ unread: true, status: 'waiting' })).toBe('updated');
		expect(teamThreadStatus({ status: 'waiting' })).toBe('waiting');
		expect(teamThreadStatus({ status: 'open' })).toBeNull();
	});

	it('shows no pill on a resolved or closed thread, even with a draft or news', () => {
		for (const status of ['resolved', 'closed'] as const) {
			expect(teamThreadStatus({ status, latestDraftStatus: 'pending', unread: true })).toBeNull();
		}
	});

	it('shows no pill while a snooze is active, and resumes once it lapses', () => {
		const snoozed = { status: 'open', latestDraftStatus: 'pending', unread: true, now };
		expect(teamThreadStatus({ ...snoozed, snoozedUntil: now + 1 })).toBeNull();
		expect(teamThreadStatus({ ...snoozed, snoozedUntil: now - 1 })).toBe('draft_ready');
		expect(teamThreadStatus({ ...snoozed, snoozedUntil: null })).toBe('draft_ready');
	});

	it('never shows a pill where the chip says Resolved or Snoozed', () => {
		const statuses = ['open', 'waiting', 'resolved', 'closed'] as const;
		const drafts = [undefined, 'pending', 'sent'] as const;
		const snoozes = [undefined, now - 1, now + 1];
		for (const status of statuses) {
			for (const latestDraftStatus of drafts) {
				for (const snoozedUntil of snoozes) {
					const chip = threadStatusChip({ status, latestDraftStatus, snoozedUntil, now });
					const pill = teamThreadStatus({
						status,
						latestDraftStatus,
						snoozedUntil,
						unread: true,
						now,
					});
					if (
						chip.label === 'shared.threadStatusChip.resolved' ||
						chip.label === 'shared.threadStatusChip.snoozed'
					) {
						expect(pill).toBeNull();
					}
					if (chip.label === 'shared.threadStatusChip.draftReady') {
						expect(pill).toBe('draft_ready');
					}
				}
			}
		}
	});
});
