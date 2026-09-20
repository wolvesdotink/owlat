import { describe, it, expect } from 'vitest';
import { isBulkKind, rankUpdates, updateRankScore, updateViewForKind } from '../updates';

/**
 * Pure ranking contract for the Updates dashboard: the classifier's
 * importance score leads, priority breaks ties below it, and newest wins
 * an exact tie. No Convex, no model.
 */

const at = (n: number) => 1_000_000 + n * 1000;

describe('updateRankScore', () => {
	it('adds a bounded priority weight on top of importance', () => {
		expect(updateRankScore({ receivedAt: 0, classification: { importance: 0.5 } })).toBe(0.5);
		expect(
			updateRankScore({ receivedAt: 0, classification: { importance: 0.5, priority: 'urgent' } })
		).toBeCloseTo(0.8);
		expect(
			updateRankScore({ receivedAt: 0, classification: { importance: 0.5, priority: 'low' } })
		).toBe(0.5);
	});

	it('reads a missing classification as zero', () => {
		expect(updateRankScore({ receivedAt: 0 })).toBe(0);
	});
});

describe('rankUpdates', () => {
	it('puts an urgent, important notice above a low-priority newsletter', () => {
		const newsletter = {
			_id: 'news',
			receivedAt: at(9),
			classification: { importance: 0.2, priority: 'low' },
		};
		const outage = {
			_id: 'outage',
			receivedAt: at(1),
			classification: { importance: 0.9, priority: 'urgent' },
		};
		const receipt = {
			_id: 'receipt',
			receivedAt: at(5),
			classification: { importance: 0.4, priority: 'normal' },
		};
		expect(rankUpdates([newsletter, outage, receipt]).map((u) => u._id)).toEqual([
			'outage',
			'receipt',
			'news',
		]);
	});

	it('breaks an exact tie by recency, newest first', () => {
		const older = { _id: 'older', receivedAt: at(1), classification: { importance: 0.5 } };
		const newer = { _id: 'newer', receivedAt: at(2), classification: { importance: 0.5 } };
		expect(rankUpdates([older, newer]).map((u) => u._id)).toEqual(['newer', 'older']);
	});

	it('does not mutate its input', () => {
		const input = [
			{ _id: 'a', receivedAt: at(1), classification: { importance: 0.1 } },
			{ _id: 'b', receivedAt: at(2), classification: { importance: 0.9 } },
		];
		rankUpdates(input);
		expect(input.map((u) => u._id)).toEqual(['a', 'b']);
	});
});

describe('updateViewForKind', () => {
	it('files bulk kinds into their tabs and everything else into updates', () => {
		expect(updateViewForKind('advertising')).toBe('promotions');
		expect(updateViewForKind('newsletter')).toBe('promotions');
		expect(updateViewForKind('notification')).toBe('notifications');
		expect(updateViewForKind('receipt')).toBe('notifications');
		expect(updateViewForKind('personal')).toBe('updates');
		expect(updateViewForKind('update')).toBe('updates');
		expect(updateViewForKind(undefined)).toBe('updates');
	});

	it('knows which kinds never expect a reply', () => {
		expect(isBulkKind('advertising')).toBe(true);
		expect(isBulkKind('receipt')).toBe(true);
		expect(isBulkKind('personal')).toBe(false);
		expect(isBulkKind(undefined)).toBe(false);
	});
});
