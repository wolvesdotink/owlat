import { describe, it, expect } from 'vitest';
import { threadPickerLabel, type PickerThread } from '../threadPicker';

const threads: PickerThread[] = [
	{
		_id: 't1' as PickerThread['_id'],
		subject: 'Renewal quote',
		contactIdentifier: 'ana@acme.test',
	},
	{ _id: 't2' as PickerThread['_id'], subject: 'Invoice 42', contactIdentifier: 'bo@zephyr.test' },
	{ _id: 't3' as PickerThread['_id'], subject: '' },
];

describe('threadPickerLabel', () => {
	it('falls back to a placeholder for a subject-less thread', () => {
		expect(threadPickerLabel(threads[2]!)).toBe('(no subject)');
		expect(threadPickerLabel(threads[0]!)).toBe('Renewal quote');
	});
});
