import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { sendTrackingFields } from '../validators/send';

/**
 * The Send lifecycle writes one patch to either send table, so a tracking
 * column that exists on only one of them fails at runtime on that send kind.
 */
describe('sendTrackingFields', () => {
	const tables = ['emailSends', 'transactionalSends'] as const;

	it.each(tables)('every shared tracking column is on %s with the same validator', (table) => {
		const fields = schema.tables[table].validator.fields as Record<string, unknown>;
		for (const [column, validator] of Object.entries(sendTrackingFields)) {
			expect(fields[column], column).toBe(validator);
		}
	});

	it('leaves queuedAt per table: required on campaign sends, optional on transactional ones', () => {
		expect(sendTrackingFields).not.toHaveProperty('queuedAt');
		expect(schema.tables.emailSends.validator.fields.queuedAt.isOptional).toBe('required');
		expect(schema.tables.transactionalSends.validator.fields.queuedAt.isOptional).toBe('optional');
	});
});
