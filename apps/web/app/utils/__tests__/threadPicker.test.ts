import { describe, it, expect } from 'vitest';
import { filterThreadCandidates, threadPickerLabel, type PickerThread } from '../threadPicker';

const threads: PickerThread[] = [
	{
		_id: 't1' as PickerThread['_id'],
		subject: 'Renewal quote',
		contactIdentifier: 'ana@acme.test',
	},
	{ _id: 't2' as PickerThread['_id'], subject: 'Invoice 42', contactIdentifier: 'bo@zephyr.test' },
	{ _id: 't3' as PickerThread['_id'], subject: '' },
];

describe('filterThreadCandidates', () => {
	it('returns everything for an empty query', () => {
		expect(filterThreadCandidates(threads, '   ')).toEqual(threads);
	});

	it('matches on subject, case-insensitively', () => {
		expect(filterThreadCandidates(threads, 'RENEWAL').map((t) => t._id)).toEqual(['t1']);
	});

	it('matches on the participant address', () => {
		expect(filterThreadCandidates(threads, 'zephyr').map((t) => t._id)).toEqual(['t2']);
	});

	it('tolerates a thread with no subject or participant', () => {
		expect(filterThreadCandidates(threads, 'nothing-matches')).toEqual([]);
	});
});

describe('threadPickerLabel', () => {
	it('falls back to a placeholder for a subject-less thread', () => {
		expect(threadPickerLabel(threads[2]!)).toBe('(no subject)');
		expect(threadPickerLabel(threads[0]!)).toBe('Renewal quote');
	});
});
