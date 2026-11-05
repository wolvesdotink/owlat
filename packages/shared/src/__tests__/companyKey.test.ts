import { describe, expect, it } from 'vitest';
import { companyKeyOf, companyKeyOfDomain, companyNameFromKey } from '../companyKey';

describe('companyKeyOf', () => {
	it('keys an address by its organisational domain', () => {
		expect(companyKeyOf('mira@northwind.example.com')).toBe('example.com');
		expect(companyKeyOf('jonas@mail.acme.co.uk')).toBe('acme.co.uk');
		expect(companyKeyOf('Jonas@ACME.CO.UK.')).toBe('acme.co.uk');
		expect(companyKeyOf('<ops@acme.de>')).toBe('acme.de');
	});

	it('puts people from one domain into the same company', () => {
		expect(companyKeyOf('a@sales.acme.com')).toBe(companyKeyOf('b@acme.com'));
	});

	it('leaves free-mail addresses without a company', () => {
		expect(companyKeyOf('leo@gmail.com')).toBeNull();
		expect(companyKeyOf('leo@gmx.de')).toBeNull();
		expect(companyKeyOf('leo@yahoo.co.uk')).toBeNull();
	});

	it('leaves the workspace’s own domains without a company', () => {
		const own = new Set(['owlat.com']);
		expect(companyKeyOf('lena@owlat.com', own)).toBeNull();
		expect(companyKeyOf('lena@team.owlat.com', own)).toBeNull();
		expect(companyKeyOf('jonas@acme.com', own)).toBe('acme.com');
	});

	it('returns null for addresses without a usable domain', () => {
		expect(companyKeyOf('')).toBeNull();
		expect(companyKeyOf('no-at-sign')).toBeNull();
		expect(companyKeyOf('trailing@')).toBeNull();
		expect(companyKeyOf('@acme.com')).toBeNull();
		expect(companyKeyOf('root@localhost')).toBeNull();
	});

	it('treats a private-suffix subdomain as its own organisation', () => {
		expect(companyKeyOfDomain('alice.github.io')).toBe('alice.github.io');
	});
});

describe('companyNameFromKey', () => {
	it('reads the first label as words', () => {
		expect(companyNameFromKey('northwind-logistics.com')).toBe('Northwind Logistics');
		expect(companyNameFromKey('acme.co.uk')).toBe('Acme');
		expect(companyNameFromKey('kestrel_studio.io')).toBe('Kestrel Studio');
	});
});
