import { describe, expect, it } from 'vitest';
import {
	SCALAR_FIELDS,
	assignColumnField,
	conflictingScalarField,
	detectColumnMapping,
	prepareCsvRows,
	scalarFieldOwners,
	type ColumnMapping,
} from '../csvImportMapping';

describe('detectColumnMapping', () => {
	it('gives Email to one column and makes the other email headers custom properties', () => {
		expect(detectColumnMapping(['email', 'secondary_email'])).toEqual({
			0: 'email',
			1: 'property',
		});
	});

	it('prefers an exact "email" header over an earlier header containing email', () => {
		expect(detectColumnMapping(['billing_email', 'E-mail', ' Email '])).toEqual({
			0: 'property',
			1: 'property',
			2: 'email',
		});
	});

	it('prefers "e-mail" over a header that only contains email', () => {
		expect(detectColumnMapping(['work_email', 'e-mail'])).toEqual({ 0: 'property', 1: 'email' });
	});

	it('falls back to the first header containing email', () => {
		expect(detectColumnMapping(['name', 'primary_email', 'billing_email'])).toEqual({
			0: 'ignore',
			1: 'email',
			2: 'property',
		});
	});

	it('gives each of First name, Last name and Language to the first matching header', () => {
		expect(
			detectColumnMapping([
				'email',
				'first_name',
				'given name',
				'surname',
				'last_name',
				'lang',
				'locale',
				'topics',
				'list',
			])
		).toEqual({
			0: 'email',
			1: 'firstName',
			2: 'property',
			3: 'lastName',
			4: 'property',
			5: 'language',
			6: 'property',
			// Topic is not a scalar field; it keeps its existing behaviour.
			7: 'topic',
			8: 'topic',
		});
	});
});

describe('assignColumnField', () => {
	const headers = [
		'email',
		'secondary_email',
		'first',
		'given',
		'surname',
		'family',
		'lang',
		'loc',
	];

	it.each(SCALAR_FIELDS)(
		'moves %s to the picked column and drops the old one to Custom property',
		(field) => {
			const mapping: ColumnMapping = { 0: 'ignore', 1: 'ignore', 2: field, 3: 'ignore' };

			const { mapping: next, displaced } = assignColumnField(mapping, headers, 3, field);

			expect(next[3]).toBe(field);
			expect(next[2]).toBe('property');
			expect(displaced).toEqual([2]);
			expect(conflictingScalarField(next)).toBeNull();
		}
	);

	it('skips a displaced column whose header is blank, since it cannot be a property key', () => {
		const { mapping } = assignColumnField({ 0: 'email', 1: 'property' }, [' ', 'mail'], 1, 'email');

		expect(mapping).toEqual({ 0: 'ignore', 1: 'email' });
	});

	it('lets several columns share a non-scalar field', () => {
		const { mapping, displaced } = assignColumnField(
			{ 0: 'email', 1: 'property', 2: 'ignore' },
			['email', 'a', 'b'],
			2,
			'property'
		);

		expect(mapping).toEqual({ 0: 'email', 1: 'property', 2: 'property' });
		expect(displaced).toEqual([]);
	});

	it('does not mutate the mapping it was given', () => {
		const mapping: ColumnMapping = { 0: 'email', 1: 'property' };
		assignColumnField(mapping, ['email', 'secondary_email'], 1, 'email');
		expect(mapping).toEqual({ 0: 'email', 1: 'property' });
	});
});

describe('scalarFieldOwners / conflictingScalarField', () => {
	it('picks the lowest column when a mapping was set with a conflict', () => {
		const mapping: ColumnMapping = { 2: 'email', 0: 'email', 1: 'firstName' };

		expect(scalarFieldOwners(mapping)).toEqual({ email: 0, firstName: 1 });
		expect(conflictingScalarField(mapping)).toBe('email');
	});

	it('reports no conflict for a clean mapping', () => {
		expect(conflictingScalarField({ 0: 'email', 1: 'property', 2: 'property' })).toBeNull();
	});
});

describe('prepareCsvRows', () => {
	it('reads the email from its one owner, never from a later nonempty email-like column', () => {
		const rows = prepareCsvRows(
			[
				['contact0@owlat.example', 'billing0@owlat.example'],
				['contact1@owlat.example', ''],
				['', 'billing2@owlat.example'],
			],
			['email', 'secondary_email'],
			// Even a conflicting mapping resolves to the first column everywhere.
			{ 0: 'email', 1: 'email' }
		);

		expect(rows.map((r) => r.contact.email)).toEqual([
			'contact0@owlat.example',
			'contact1@owlat.example',
			'',
		]);
		expect(rows.map((r) => r.status)).toEqual(['valid', 'valid', 'missing']);
	});

	it('carries the other email column as a custom property keyed by its header', () => {
		const [first, second] = prepareCsvRows(
			[
				[' contact0@owlat.example ', 'billing0@owlat.example'],
				['contact1@owlat.example', '  '],
			],
			['email', ' secondary_email '],
			{ 0: 'email', 1: 'property' }
		);

		expect(first!.contact).toEqual({
			email: 'contact0@owlat.example',
			properties: { secondary_email: 'billing0@owlat.example' },
		});
		expect(second!.contact).toEqual({ email: 'contact1@owlat.example' });
	});

	it('flags invalid and case-insensitive duplicate addresses', () => {
		const rows = prepareCsvRows(
			[['a@b.com'], ['not-an-email'], ['A@B.com'], ['c@d.com']],
			['email'],
			{ 0: 'email' }
		);

		expect(rows.map((r) => r.status)).toEqual(['valid', 'invalid', 'duplicate', 'valid']);
	});
});
