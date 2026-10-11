import { describe, expect, it } from 'vitest';
import {
	callInventory,
	compareInventories,
	defaultPathOf,
	ledgerRowsFromJsonl,
	type LedgerCallRow,
} from '../callInventory';

const row = (patch: Partial<LedgerCallRow>): LedgerCallRow => ({
	feature: 'agent_classify',
	promptTokens: 100,
	completionTokens: 10,
	totalTokens: 110,
	costUsd: 0.001,
	...patch,
});

/** Two Team messages: guard + classify + a retried draft; classify + a shadow category judgment. */
const baseline: LedgerCallRow[] = [
	row({
		rootRequestId: 'team:m1',
		requestId: 'g1',
		task: 'mail.guard',
		feature: 'agent_security_scan',
	}),
	row({ rootRequestId: 'team:m1', requestId: 'c1', task: 'mail.classify' }),
	row({ rootRequestId: 'team:m1', requestId: 'd1', task: 'mail.draft', attempt: 1, costUsd: 0.02 }),
	row({ rootRequestId: 'team:m1', requestId: 'd1', task: 'mail.draft', attempt: 2, costUsd: 0.02 }),
	row({ rootRequestId: 'team:m2', requestId: 'c2', task: 'mail.classify', isEstimated: true }),
	row({
		rootRequestId: 'team:m2',
		requestId: 's2',
		task: 'mail.category',
		plane: 'decision',
		budgetClass: 'shadow',
		costUsd: 0.0002,
	}),
	row({ feature: 'postbox_category' }),
];

describe('callInventory', () => {
	it('groups rows by root request and counts requests, logical calls and retries', () => {
		const inventory = callInventory(baseline);
		expect(inventory.rows).toBe(7);
		expect(inventory.unattributedRows).toBe(1);
		expect(inventory.unattributedCostUsd).toBeCloseTo(0.001, 10);
		expect(inventory.paths).toHaveLength(1);
		const team = inventory.paths[0];
		expect(team).toMatchObject({
			path: 'team',
			roots: 2,
			messages: 2,
			isRootsOnly: true,
			requests: 6,
			logicalCalls: 5,
			retries: 1,
			shadowRequests: 1,
		});
		expect(team?.costUsd).toBeCloseTo(0.0432, 10);
		expect(team?.estimatedCostUsd).toBeCloseTo(0.001, 10);
		expect(team?.shadowCostUsd).toBeCloseTo(0.0002, 10);
		expect(team?.requestsPerMessage).toMatchObject({ mean: 3, p50: 2, max: 4 });
		expect(team?.byTask['mail.draft']).toMatchObject({
			requests: 2,
			logicalCalls: 1,
			retries: 1,
			requestsPerMessage: 1,
		});
		expect(Object.keys(team?.byTask ?? {})).toEqual([
			'mail.category',
			'mail.classify',
			'mail.draft',
			'mail.guard',
		]);
	});

	it('counts messages that made no call when the path’s message count is given', () => {
		const inventory = callInventory(baseline, { messageCounts: { team: 4, postbox: 3 } });
		const team = inventory.paths.find((p) => p.path === 'team');
		expect(team).toMatchObject({ roots: 2, messages: 4, isRootsOnly: false });
		expect(team?.requestsPerMessage).toMatchObject({ mean: 1.5, p50: 0, max: 4 });
		expect(team?.byTask['mail.classify']?.requestsPerMessage).toBe(0.5);
		// A path with messages and no rows at all still appears, at zero.
		const postbox = inventory.paths.find((p) => p.path === 'postbox');
		expect(postbox).toMatchObject({ roots: 0, messages: 3, requests: 0 });
		expect(postbox?.requestsPerMessage.mean).toBe(0);
		// A count below the roots seen cannot hide a root.
		expect(callInventory(baseline, { messageCounts: { team: 1 } }).paths[0]?.messages).toBe(2);
	});

	it('names a root’s path from its id, else from its features', () => {
		expect(defaultPathOf('eval.decision.team:t/m1', [])).toBe('eval.decision.team');
		expect(defaultPathOf('k7abc', [row({ feature: 'postbox_category' })])).toBe('postbox');
		expect(defaultPathOf('k7abc', [row({ feature: 'interpret_verify' })])).toBe('postbox');
		expect(defaultPathOf('k7abc', [row({ feature: 'visualization' })])).toBe('other');
		const custom = callInventory(baseline, { pathOf: () => 'all', taskOf: (r) => r.feature });
		expect(custom.paths.map((p) => p.path)).toEqual(['all']);
		expect(Object.keys(custom.paths[0]?.byTask ?? {})).toEqual([
			'agent_classify',
			'agent_security_scan',
		]);
	});

	it('reports a missing task under its feature', () => {
		const inventory = callInventory([row({ rootRequestId: 'team:m9', feature: 'agent_draft' })]);
		expect(Object.keys(inventory.paths[0]?.byTask ?? {})).toEqual(['feature:agent_draft']);
	});
});

describe('compareInventories', () => {
	it('shows the per-message change by path and task, a vanished task as zero', () => {
		const before = callInventory(baseline, { messageCounts: { team: 2 } });
		// After: the guard is skipped and the draft no longer retries.
		const after = callInventory(
			baseline.filter((r) => r.task !== 'mail.guard' && (r.attempt ?? 1) === 1),
			{ messageCounts: { team: 2 } }
		);
		const deltas = compareInventories(before, after);
		const path = deltas.find((d) => d.path === 'team' && d.task === null);
		expect(path?.requestsPerMessage).toEqual({ before: 3, after: 2, change: -1 });
		const guard = deltas.find((d) => d.task === 'mail.guard');
		expect(guard?.requestsPerMessage).toEqual({ before: 0.5, after: 0, change: -0.5 });
		expect(guard?.costPerMessage.after).toBe(0);
		const fresh = compareInventories(callInventory([]), after);
		expect(fresh.find((d) => d.path === 'team' && d.task === null)?.requestsPerMessage).toEqual({
			before: null,
			after: 2,
			change: null,
		});
	});
});

describe('ledgerRowsFromJsonl', () => {
	it('reads exported ledger documents and skips anything else', () => {
		const text = [
			JSON.stringify({ _id: 'a', ...row({ rootRequestId: 'team:m1' }) }),
			'',
			'not json',
			JSON.stringify({ feature: 'x' }),
			JSON.stringify(row({})),
		].join('\n');
		const { rows, skipped } = ledgerRowsFromJsonl(text);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.rootRequestId).toBe('team:m1');
		expect(skipped).toBe(2);
	});
});
