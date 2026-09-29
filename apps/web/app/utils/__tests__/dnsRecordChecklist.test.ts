import { describe, it, expect } from 'vitest';
import {
	buildSendingChecklist,
	isOutsideZone,
	recordFqdn,
	summarizeChecklist,
	toZoneFileLines,
} from '~/utils/dnsRecordChecklist';

const ok = { verified: true };
const missing = { verified: false, error: 'No TXT record found' };

const sesDomain = (verificationResults?: Record<string, unknown>) => ({
	dnsRecords: {
		spf: { type: 'TXT' as const, host: '@', value: 'v=spf1 include:amazonses.com ~all' },
		dkim: [
			{ type: 'CNAME' as const, host: 'a1._domainkey', value: 'a1.dkim.amazonses.com' },
			{ type: 'CNAME' as const, host: 'b2._domainkey', value: 'b2.dkim.amazonses.com' },
			{ type: 'CNAME' as const, host: 'c3._domainkey', value: 'c3.dkim.amazonses.com' },
		],
		dmarc: { type: 'TXT' as const, host: '_dmarc', value: 'v=DMARC1; p=none' },
		mailFrom: [
			{
				type: 'MX' as const,
				host: 'bounce',
				value: 'feedback-smtp.eu-west-1.amazonses.com',
				priority: 10,
			},
			{ type: 'TXT' as const, host: 'bounce', value: 'v=spf1 include:amazonses.com ~all' },
		],
	},
	verificationResults,
});

describe('buildSendingChecklist', () => {
	it('lists every record once, in display order, with its own label', () => {
		const entries = buildSendingChecklist(sesDomain());
		expect(entries.map((e) => e.label)).toEqual([
			'SPF',
			'DKIM 1',
			'DKIM 2',
			'DKIM 3',
			'DMARC',
			'MAIL FROM MX',
			'MAIL FROM SPF',
		]);
		expect(entries.map((e) => e.group)).toEqual([
			'authentication',
			'authentication',
			'authentication',
			'authentication',
			'authentication',
			'returnPath',
			'returnPath',
		]);
		expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
	});

	it('names a lone DKIM selector without a number', () => {
		const domain = sesDomain();
		domain.dnsRecords.dkim = domain.dnsRecords.dkim.slice(0, 1);
		expect(buildSendingChecklist(domain).map((e) => e.label)).toContain('DKIM');
	});

	it('pairs each DKIM and MAIL FROM record with the verification at the same index', () => {
		const entries = buildSendingChecklist(
			sesDomain({ spf: ok, dkim: [ok, missing, ok], dmarc: ok, mailFrom: [ok, missing] })
		);
		const byLabel = Object.fromEntries(entries.map((e) => [e.label, e.status]));
		expect(byLabel).toEqual({
			SPF: 'verified',
			'DKIM 1': 'verified',
			'DKIM 2': 'failed',
			'DKIM 3': 'verified',
			DMARC: 'verified',
			'MAIL FROM MX': 'verified',
			'MAIL FROM SPF': 'failed',
		});
	});

	it('marks every record unchecked before the first verification', () => {
		const statuses = buildSendingChecklist(sesDomain()).map((e) => e.status);
		expect(new Set(statuses)).toEqual(new Set(['unchecked']));
	});

	it('skips a record with no value and returns nothing without records', () => {
		const domain = sesDomain();
		(domain.dnsRecords as Record<string, unknown>)['spf'] = { type: 'TXT', host: '@', value: '' };
		expect(buildSendingChecklist(domain).some((e) => e.id === 'spf')).toBe(false);
		expect(buildSendingChecklist({ dnsRecords: null })).toEqual([]);
	});
});

describe('summarizeChecklist', () => {
	it('counts found records and lists the outstanding ones by record', () => {
		const summary = summarizeChecklist(
			buildSendingChecklist(
				sesDomain({ spf: ok, dkim: [ok, missing, ok], dmarc: missing, mailFrom: [ok, ok] })
			)
		);
		expect(summary).toMatchObject({ total: 7, verified: 5, checked: true, allVerified: false });
		expect(summary.outstanding.map((e) => e.label)).toEqual(['DKIM 2', 'DMARC']);
	});

	it('is not "checked" until a verification result exists', () => {
		const summary = summarizeChecklist(buildSendingChecklist(sesDomain()));
		expect(summary.checked).toBe(false);
		expect(summary.outstanding).toHaveLength(7);
	});

	it('reports all verified only when every record is', () => {
		const all = sesDomain({ spf: ok, dkim: [ok, ok, ok], dmarc: ok, mailFrom: [ok, ok] });
		expect(summarizeChecklist(buildSendingChecklist(all)).allVerified).toBe(true);
		expect(summarizeChecklist([]).allVerified).toBe(false);
	});
});

describe('recordFqdn', () => {
	it('resolves the apex, a relative host and an absolute host', () => {
		expect(recordFqdn({ host: '@' }, 'example.com')).toBe('example.com');
		expect(recordFqdn({ host: '_dmarc' }, 'example.com')).toBe('_dmarc.example.com');
		expect(recordFqdn({ host: 'bounces.owlat.com', hostIsFqdn: true }, 'example.com')).toBe(
			'bounces.owlat.com'
		);
	});
});

describe('toZoneFileLines', () => {
	const entries = buildSendingChecklist(sesDomain());
	const line = (id: string, overrides?: Record<string, string>) =>
		toZoneFileLines(
			entries.filter((e) => e.id === id),
			'mail.example.com',
			{ valueOverrides: overrides }
		);

	it('writes absolute names, a TTL and the class', () => {
		expect(line('dmarc')).toBe('_dmarc.mail.example.com.\t3600\tIN\tTXT\t"v=DMARC1; p=none"');
	});

	it('terminates CNAME targets and prefixes MX with its priority', () => {
		expect(line('dkim-1')).toBe(
			'b2._domainkey.mail.example.com.\t3600\tIN\tCNAME\tb2.dkim.amazonses.com.'
		);
		expect(line('mail-from-0')).toBe(
			'bounce.mail.example.com.\t3600\tIN\tMX\t10 feedback-smtp.eu-west-1.amazonses.com.'
		);
	});

	it('splits a long TXT value into 255-character strings', () => {
		const key = `v=DKIM1; k=rsa; p=${'A'.repeat(400)}`;
		const [entry] = buildSendingChecklist({
			dnsRecords: { dkim: [{ type: 'TXT', host: 's1._domainkey', value: key }] },
		});
		const rdata = toZoneFileLines([entry!], 'example.com').split('\t')[4]!;
		const strings = rdata.match(/"[^"]*"/g)!;
		expect(strings.map((s) => s.length - 2)).toEqual([255, key.length - 255]);
		expect(strings.map((s) => s.slice(1, -1)).join('')).toBe(key);
	});

	it('escapes quotes and backslashes in TXT values', () => {
		const [entry] = buildSendingChecklist({
			dnsRecords: { spf: { type: 'TXT', host: '@', value: 'a"b\\c' } },
		});
		expect(toZoneFileLines([entry!], 'example.com')).toBe(
			'example.com.\t3600\tIN\tTXT\t"a\\"b\\\\c"'
		);
	});

	it('uses an override value in place of the record value', () => {
		expect(line('spf', { spf: 'v=spf1 include:other.test include:amazonses.com ~all' })).toBe(
			'mail.example.com.\t3600\tIN\tTXT\t"v=spf1 include:other.test include:amazonses.com ~all"'
		);
	});

	it('puts one record per line', () => {
		expect(toZoneFileLines(entries, 'mail.example.com').split('\n')).toHaveLength(7);
	});

	it('puts a note as a comment line directly above its record', () => {
		const merged = 'v=spf1 include:other.test include:amazonses.com ~all';
		const text = toZoneFileLines(entries, 'mail.example.com', {
			valueOverrides: { spf: merged },
			notes: { spf: 'Replace the existing v=spf1 record.' },
		});
		const lines = text.split('\n');
		expect(lines).toHaveLength(8);
		expect(lines.slice(0, 2)).toEqual([
			'; Replace the existing v=spf1 record.',
			`mail.example.com.\t3600\tIN\tTXT\t"${merged}"`,
		]);
		// Only the noted record carries a comment.
		expect(lines.filter((l) => l.startsWith(';'))).toHaveLength(1);
	});

	it('keeps a multi-line note on one comment line', () => {
		const text = toZoneFileLines(
			entries.filter((e) => e.id === 'spf'),
			'mail.example.com',
			{ notes: { spf: 'first\nsecond' } }
		);
		expect(text.split('\n')[0]).toBe('; first second');
	});

	describe('a record outside the domain zone', () => {
		// A shared return-path host on the operator's own domain.
		const sharedBounce = buildSendingChecklist({
			dnsRecords: {
				spf: { type: 'TXT', host: '@', value: 'v=spf1 include:_spf.owlat.test ~all' },
				mailFrom: [
					{ type: 'MX', hostname: 'bounces.owlat.test', value: 'mx.owlat.test', priority: 10 },
				],
			},
		});
		const note = (fqdn: string) => `Publish ${fqdn} elsewhere.`;

		it('is written commented out, below its note, so an import skips it', () => {
			expect(
				toZoneFileLines(sharedBounce, 'mail.example.com', { outOfZoneNote: note }).split('\n')
			).toEqual([
				'mail.example.com.\t3600\tIN\tTXT\t"v=spf1 include:_spf.owlat.test ~all"',
				'; Publish bounces.owlat.test elsewhere.',
				'; bounces.owlat.test.\t3600\tIN\tMX\t10 mx.owlat.test.',
			]);
		});

		it('is still commented out without a note', () => {
			expect(toZoneFileLines(sharedBounce.slice(1), 'mail.example.com')).toBe(
				'; bounces.owlat.test.\t3600\tIN\tMX\t10 mx.owlat.test.'
			);
		});

		it('counts an absolute host inside the registrable zone as in zone', () => {
			const [entry] = buildSendingChecklist({
				dnsRecords: {
					mailFrom: [{ type: 'TXT', hostname: 'bounce.example.com', value: 'v=spf1 -all' }],
				},
			});
			expect(toZoneFileLines([entry!], 'mail.example.com', { outOfZoneNote: note })).toBe(
				'bounce.example.com.\t3600\tIN\tTXT\t"v=spf1 -all"'
			);
		});
	});
});

describe('isOutsideZone', () => {
	it('compares against the registrable zone, not the sending domain', () => {
		expect(isOutsideZone('bounce.example.com', 'mail.example.com')).toBe(false);
		expect(isOutsideZone('example.com', 'mail.example.com')).toBe(false);
		expect(isOutsideZone('bounces.owlat.test', 'mail.example.com')).toBe(true);
		expect(isOutsideZone('bounce.example.co.uk', 'example.com')).toBe(true);
	});

	it('never flags a record when the domain has no registrable zone', () => {
		expect(isOutsideZone('bounces.owlat.test', 'localhost')).toBe(false);
	});
});
