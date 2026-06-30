import { describe, it, expect } from 'vitest';
import type { Id } from '@owlat/api/dataModel';
import {
	contactPickerLabel,
	addPickedContact,
	removePickedContact,
	unselectedCandidates,
	type PickerContact,
} from '../contactPicker';

const id = (s: string) => s as Id<'contacts'>;

const ada: PickerContact = { _id: id('c1'), email: 'ada@x.com', firstName: 'Ada', lastName: 'Lovelace' };
const grace: PickerContact = { _id: id('c2'), email: 'grace@x.com', firstName: 'Grace' };
const anon: PickerContact = { _id: id('c3'), email: 'anon@x.com' };

describe('contactPickerLabel', () => {
	it('uses the full name when present', () => {
		expect(contactPickerLabel(ada)).toBe('Ada Lovelace');
	});

	it('falls back to first name only', () => {
		expect(contactPickerLabel(grace)).toBe('Grace');
	});

	it('falls back to email when no name', () => {
		expect(contactPickerLabel(anon)).toBe('anon@x.com');
	});
});

describe('addPickedContact', () => {
	it('appends a new contact', () => {
		expect(addPickedContact([ada], grace)).toEqual([ada, grace]);
	});

	it('de-dups by id and returns the same array reference', () => {
		const selected = [ada];
		const result = addPickedContact(selected, ada);
		expect(result).toBe(selected);
		expect(result).toEqual([ada]);
	});

	it('does not mutate the input array', () => {
		const selected = [ada];
		addPickedContact(selected, grace);
		expect(selected).toEqual([ada]);
	});
});

describe('removePickedContact', () => {
	it('removes by id', () => {
		expect(removePickedContact([ada, grace], id('c1'))).toEqual([grace]);
	});

	it('is a no-op for an absent id', () => {
		expect(removePickedContact([ada], id('zzz'))).toEqual([ada]);
	});
});

describe('unselectedCandidates', () => {
	it('filters out already-selected contacts', () => {
		expect(unselectedCandidates([ada, grace, anon], [grace])).toEqual([ada, anon]);
	});

	it('returns all candidates when nothing is selected', () => {
		expect(unselectedCandidates([ada, grace], [])).toEqual([ada, grace]);
	});
});
