import { describe, it, expect } from 'vitest';
import { compareNeedsAttention, type NeedsAttentionThread } from '../threadSort';

/** Minimal thread builder — only the fields the comparator reads. */
function t(overrides: Partial<NeedsAttentionThread> = {}): NeedsAttentionThread {
	return { unread: false, lastMessageAt: 1_000, ...overrides };
}

describe('compareNeedsAttention', () => {
	it('floats drafts-ready above unassigned-unread above the rest', () => {
		const draftReady = t({ latestDraftStatus: 'pending', lastMessageAt: 5_000 });
		const unassignedUnread = t({ unread: true, lastMessageAt: 4_000 });
		const plain = t({ assignedTo: 'u1', lastMessageAt: 1_000 });

		const sorted = [plain, unassignedUnread, draftReady].sort(compareNeedsAttention);
		expect(sorted).toEqual([draftReady, unassignedUnread, plain]);
	});

	it('within a tier, orders oldest activity first', () => {
		const older = t({ lastMessageAt: 1_000 });
		const newer = t({ lastMessageAt: 9_000 });
		const middle = t({ lastMessageAt: 5_000 });

		const sorted = [newer, older, middle].sort(compareNeedsAttention);
		expect(sorted.map((x) => x.lastMessageAt)).toEqual([1_000, 5_000, 9_000]);
	});

	it('treats an assigned-but-unread thread as tier 2 (only UNassigned unread floats)', () => {
		const assignedUnread = t({ assignedTo: 'u1', unread: true, lastMessageAt: 8_000 });
		const unassignedUnread = t({ unread: true, lastMessageAt: 2_000 });
		expect(compareNeedsAttention(unassignedUnread, assignedUnread)).toBeLessThan(0);
	});

	it('treats a read unassigned thread as tier 2, below a draft-ready thread', () => {
		const unassignedRead = t({ lastMessageAt: 500 });
		const draftReady = t({ latestDraftStatus: 'pending', lastMessageAt: 9_999 });
		expect(compareNeedsAttention(draftReady, unassignedRead)).toBeLessThan(0);
	});

	it('is a stable total order (sorting is idempotent)', () => {
		const rows = [
			t({ latestDraftStatus: 'pending', lastMessageAt: 3_000 }),
			t({ unread: true, lastMessageAt: 3_000 }),
			t({ assignedTo: 'a', lastMessageAt: 100 }),
			t({ lastMessageAt: 7_000 }),
		];
		const once = [...rows].sort(compareNeedsAttention);
		const twice = [...once].sort(compareNeedsAttention);
		expect(twice).toEqual(once);
	});
});
