import { describe, expect, it } from 'vitest';
import {
	accountExportPercent,
	accountExportResourceLabelKey,
	buildAccountExportManifest,
	plannedRowTotal,
} from '../accountExportProgress';

const PLAN = {
	personal: [
		{ resource: 'mailboxes', count: 2, isCapped: false },
		{ resource: 'mailMessages', count: 4831, isCapped: false },
		{ resource: 'mailDrafts', count: 2000, isCapped: true },
	],
	organizationResources: ['contacts', 'campaigns'],
};

describe('buildAccountExportManifest', () => {
	it('lists personal resources with their counts, then the organization ones', () => {
		const rows = buildAccountExportManifest(PLAN);
		expect(rows.map((row) => row.resource)).toEqual([
			'mailboxes',
			'mailMessages',
			'mailDrafts',
			'contacts',
			'campaigns',
		]);
		expect(rows[1]).toEqual({
			resource: 'mailMessages',
			labelKey: 'shared.accountExportResources.mailMessages',
			count: 4831,
			isCapped: false,
		});
	});

	it('marks an organization resource as included but not counted in advance', () => {
		const contacts = buildAccountExportManifest(PLAN).find((row) => row.resource === 'contacts');
		expect(contacts?.count).toBeNull();
		expect(contacts?.isCapped).toBe(false);
	});

	it('carries the capped flag through, so the card can say "more than"', () => {
		const drafts = buildAccountExportManifest(PLAN).find((row) => row.resource === 'mailDrafts');
		expect(drafts?.isCapped).toBe(true);
	});

	it('derives a label key for any resource the shared vocabulary adds', () => {
		expect(accountExportResourceLabelKey('somethingNew')).toBe(
			'shared.accountExportResources.somethingNew'
		);
	});
});

describe('plannedRowTotal', () => {
	it('sums the counted rows and ignores the uncounted ones', () => {
		expect(plannedRowTotal(buildAccountExportManifest(PLAN))).toBe(2 + 4831 + 2000);
	});
});

describe('accountExportPercent', () => {
	it('is indeterminate until a denominator exists', () => {
		expect(accountExportPercent({ rowsWritten: 12, plannedRows: 0 })).toBeNull();
	});

	it('tracks rows written against the plan', () => {
		expect(accountExportPercent({ rowsWritten: 25, plannedRows: 100 })).toBe(25);
	});

	it('never reads 100 while work may remain', () => {
		// The plan counts only the resources counted in advance, so a real run
		// overshoots it — the bar must not claim done before the caller says so.
		expect(accountExportPercent({ rowsWritten: 500, plannedRows: 100 })).toBe(99);
		expect(accountExportPercent({ rowsWritten: 100, plannedRows: 100 })).toBe(99);
	});

	it('reaches 100 only when the export reports completion', () => {
		expect(accountExportPercent({ rowsWritten: 3, plannedRows: 100, isComplete: true })).toBe(100);
		expect(accountExportPercent({ rowsWritten: 0, plannedRows: 0, isComplete: true })).toBe(100);
	});

	it('never goes negative on a nonsensical count', () => {
		expect(accountExportPercent({ rowsWritten: -5, plannedRows: 100 })).toBe(0);
	});
});
