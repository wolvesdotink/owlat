import { describe, expect, it } from 'vitest';
import {
	DELIVERABILITY_COMPLETED_RETENTION_DAYS,
	DELIVERABILITY_EVIDENCE_RETENTION_DAYS,
} from '@owlat/shared/retentionHorizons';
import {
	POSTBOX_TRASH_AUTO_PURGE_DEFAULT,
	POSTBOX_TRASH_AUTO_PURGE_OPTIONS,
	dataRetentionStatements,
	resolvePostboxTrashAutoPurgeDays,
} from '../postboxTrashRetention';

describe('resolvePostboxTrashAutoPurgeDays', () => {
	it('defaults an unset preference to Never', () => {
		expect(resolvePostboxTrashAutoPurgeDays(undefined)).toBe(0);
		expect(resolvePostboxTrashAutoPurgeDays(null)).toBe(0);
		expect(POSTBOX_TRASH_AUTO_PURGE_DEFAULT).toBe(0);
	});

	it('keeps a horizon the control offers', () => {
		expect(resolvePostboxTrashAutoPurgeDays(7)).toBe(7);
		expect(resolvePostboxTrashAutoPurgeDays(30)).toBe(30);
		expect(resolvePostboxTrashAutoPurgeDays(90)).toBe(90);
	});

	it('falls back to Never for a value outside the closed set', () => {
		// A horizon nobody chose must never become a horizon that deletes mail.
		expect(resolvePostboxTrashAutoPurgeDays(1)).toBe(0);
		expect(resolvePostboxTrashAutoPurgeDays(3650)).toBe(0);
	});

	it('offers every option through the picker, keys not prose', () => {
		expect(POSTBOX_TRASH_AUTO_PURGE_OPTIONS.map((option) => option.value)).toEqual([0, 7, 30, 90]);
		for (const option of POSTBOX_TRASH_AUTO_PURGE_OPTIONS) {
			expect(option.label.startsWith('shared.postboxTrashAutoPurge.')).toBe(true);
		}
	});
});

describe('dataRetentionStatements', () => {
	it('says mail, trash and spam are kept until the owner deletes them', () => {
		const statements = dataRetentionStatements(0);
		for (const id of ['mail', 'trash', 'spam'] as const) {
			expect(statements.find((statement) => statement.id === id)?.valueKey).toBe(
				'shared.dataRetention.keptUntilDeleted'
			);
		}
	});

	it('states the chosen trash horizon once the user opts in', () => {
		const trash = dataRetentionStatements(30).find((statement) => statement.id === 'trash');
		expect(trash?.valueKey).toBe('shared.dataRetention.trashPurgedAfter');
		expect(trash?.params).toEqual({ days: 30 });
	});

	it('quotes the deliverability horizons the sweeps actually enforce', () => {
		const statements = dataRetentionStatements(0);
		expect(
			statements.find((statement) => statement.id === 'deliverabilityEvidence')?.params
		).toEqual({ days: DELIVERABILITY_EVIDENCE_RETENTION_DAYS });
		expect(
			statements.find((statement) => statement.id === 'deliverabilityCompleted')?.params
		).toEqual({ days: DELIVERABILITY_COMPLETED_RETENTION_DAYS });
	});

	it('names every line through the catalog', () => {
		for (const statement of dataRetentionStatements(7)) {
			expect(statement.labelKey.startsWith('shared.dataRetention.')).toBe(true);
			expect(statement.valueKey.startsWith('shared.dataRetention.')).toBe(true);
		}
	});
});
