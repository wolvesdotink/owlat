import { describe, expect, it } from 'vitest';
import { isLookupDomain, senderLogoDomain } from '../senderLogos/eligibility';
import { acceptedLogoType, bimiLogoUrl, isDmarcEnforcing } from '../senderLogos/logoRecords';

const PASSING = { fromAddress: 'billing@mail.acme-bank.com', dmarcResult: 'pass' } as const;

describe('senderLogoDomain', () => {
	it('keys a DMARC-passing sender by its organisational domain', () => {
		expect(senderLogoDomain(PASSING)).toBe('acme-bank.com');
		expect(senderLogoDomain({ ...PASSING, dmarcResult: ' PASS ' })).toBe('acme-bank.com');
	});

	it('keeps initials for anything DMARC did not pass', () => {
		for (const dmarcResult of [undefined, 'fail', 'none', 'temperror', 'permerror']) {
			expect(senderLogoDomain({ ...PASSING, dmarcResult })).toBeNull();
		}
	});

	it('does not count an ARC rescue as the From domain proving itself', () => {
		expect(senderLogoDomain({ ...PASSING, dmarcOverride: 'arc' })).toBeNull();
	});

	it('keeps initials for spam, quarantine and infected mail', () => {
		expect(senderLogoDomain({ ...PASSING, spamVerdict: 'spam' })).toBeNull();
		expect(senderLogoDomain({ ...PASSING, spamVerdict: 'quarantine' })).toBeNull();
		expect(senderLogoDomain({ ...PASSING, virusVerdict: 'infected' })).toBeNull();
		expect(senderLogoDomain({ ...PASSING, spamVerdict: 'ham' })).toBe('acme-bank.com');
	});

	it('keeps initials for a spoofed or lookalike From domain', () => {
		expect(
			senderLogoDomain({ ...PASSING, senderHeuristics: { isFromDomainSpoofed: true } })
		).toBeNull();
		expect(
			senderLogoDomain({
				...PASSING,
				senderHeuristics: { lookalikeOfContactDomain: 'acmebank.com' },
			})
		).toBeNull();
		expect(senderLogoDomain({ ...PASSING, senderHeuristics: { isFirstTimeSender: true } })).toBe(
			'acme-bank.com'
		);
	});

	it('never shows a webmail provider logo for a person on it', () => {
		for (const fromAddress of [
			'ada@gmail.com',
			'ada@outlook.com',
			'ada@gmx.de',
			'ada@yahoo.co.uk',
		]) {
			expect(senderLogoDomain({ ...PASSING, fromAddress })).toBeNull();
		}
	});

	it('treats a tenant of a hosting suffix as its own organisation', () => {
		expect(senderLogoDomain({ ...PASSING, fromAddress: 'a@shop.github.io' })).toBe(
			'shop.github.io'
		);
	});

	it('returns null for an address with no usable domain', () => {
		expect(senderLogoDomain({ ...PASSING, fromAddress: 'nobody' })).toBeNull();
		expect(senderLogoDomain({ ...PASSING, fromAddress: 'a@' })).toBeNull();
		expect(senderLogoDomain({ ...PASSING, fromAddress: 'a@localhost' })).toBeNull();
	});
});

describe('isLookupDomain', () => {
	it('sends no lookup to names reserved for tests and documentation', () => {
		for (const domain of ['example.com', 'example.org', 'acme.example', 'shop.test', 'a.invalid']) {
			expect(isLookupDomain(domain)).toBe(false);
		}
		expect(isLookupDomain('acme-bank.com')).toBe(true);
	});
});

describe('isDmarcEnforcing', () => {
	it('accepts quarantine and reject on all mail', () => {
		expect(isDmarcEnforcing(['v=DMARC1; p=reject; rua=mailto:r@acme-bank.com'])).toBe(true);
		expect(isDmarcEnforcing(['v=DMARC1;p=quarantine;pct=100'])).toBe(true);
	});

	it('refuses monitoring, partial enforcement and ambiguous records', () => {
		expect(isDmarcEnforcing(['v=DMARC1; p=none'])).toBe(false);
		expect(isDmarcEnforcing(['v=DMARC1; p=reject; pct=50'])).toBe(false);
		expect(isDmarcEnforcing(['v=DMARC1; p=reject', 'v=DMARC1; p=none'])).toBe(false);
		expect(isDmarcEnforcing(['v=spf1 -all'])).toBe(false);
		expect(isDmarcEnforcing([])).toBe(false);
	});
});

describe('bimiLogoUrl', () => {
	it('reads the HTTPS logo of a single BIMI record', () => {
		expect(
			bimiLogoUrl(['v=BIMI1; l=https://acme-bank.com/bimi.svg; a=https://acme-bank.com/vmc.pem'])
		).toBe('https://acme-bank.com/bimi.svg');
	});

	it('refuses a declined, plain-HTTP, duplicated or missing record', () => {
		expect(bimiLogoUrl(['v=BIMI1; l=;'])).toBeNull();
		expect(bimiLogoUrl(['v=BIMI1; l=http://acme-bank.com/bimi.svg'])).toBeNull();
		expect(
			bimiLogoUrl(['v=BIMI1; l=https://a.example/1.svg', 'v=BIMI1; l=https://a.example/2.svg'])
		).toBeNull();
		expect(bimiLogoUrl(['v=spf1 -all'])).toBeNull();
	});
});

const bytes = (text: string) => new TextEncoder().encode(text);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);
const SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';

describe('acceptedLogoType', () => {
	it('keeps images whose bytes match their declared type', () => {
		expect(acceptedLogoType('image/png', PNG)).toBe('image/png');
		expect(acceptedLogoType('image/vnd.microsoft.icon', ICO)).toBe('image/x-icon');
		expect(acceptedLogoType('image/svg+xml', bytes(SVG))).toBe('image/svg+xml');
	});

	it('refuses a declared type the bytes contradict', () => {
		expect(acceptedLogoType('image/png', bytes('<html>'))).toBeNull();
		expect(acceptedLogoType('image/x-icon', PNG)).toBeNull();
		expect(acceptedLogoType('text/html', PNG)).toBeNull();
		expect(acceptedLogoType('image/png', new Uint8Array())).toBeNull();
	});

	it('refuses an SVG with script or a reference outside itself', () => {
		const withScript = SVG.replace('<rect', '<script>alert(1)</script><rect');
		const withImage = SVG.replace('<rect', '<image href="https://tracker.example/p.png"/><rect');
		const withCss = SVG.replace('<rect', '<style>rect{fill:url(//tracker.example/p)}</style><rect');
		for (const svg of [withScript, withImage, withCss]) {
			expect(acceptedLogoType('image/svg+xml', bytes(svg))).toBeNull();
		}
		const internal = SVG.replace('<rect', '<use href="#r"/><rect id="r"');
		expect(acceptedLogoType('image/svg+xml', bytes(internal))).toBe('image/svg+xml');
	});

	it('refuses an outside reference hidden behind XML or CSS escapes', () => {
		const encodedHref = SVG.replace(
			'<rect',
			'<image href="&#104;ttps://tracker.example/p.png"/><rect'
		);
		const cssEscape = SVG.replace(
			'<rect',
			'<rect fill="url(\\68 ttps://tracker.example/p)"/><rect'
		);
		const styleImport = SVG.replace('<rect', '<style>@\\69mport "x.css";</style><rect');
		for (const svg of [encodedHref, cssEscape, styleImport]) {
			expect(acceptedLogoType('image/svg+xml', bytes(svg))).toBeNull();
		}
		const gradient = SVG.replace('<rect', '<rect fill="url(#g)"/><rect');
		expect(acceptedLogoType('image/svg+xml', bytes(gradient))).toBe('image/svg+xml');
	});

	it('takes only SVG for a BIMI logo', () => {
		expect(acceptedLogoType('image/png', PNG, { svgOnly: true })).toBeNull();
		expect(acceptedLogoType('image/svg+xml', bytes(SVG), { svgOnly: true })).toBe('image/svg+xml');
	});
});
