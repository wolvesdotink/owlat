import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
	DMARC_REPORT_MAX_RECORDS,
	DMARC_REPORT_MAX_ZIP_ENTRIES,
	locateZipXmlEntry,
	parseDmarcReport,
	sniffDmarcReportContainer,
} from '../dmarcReport';
import { parseDmarcXml } from '../dmarcReportXml';

const fixture = readFileSync(
	new URL('../../../../apps/api/fixtures/dmarc/google-aggregate.xml', import.meta.url),
	'utf8'
);

/** A minimal single-pass zip writer: local headers, then the central directory. */
function zip(entries: Array<{ name: string; body: Uint8Array; method?: 0 | 8; flags?: number }>) {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const method = entry.method ?? 8;
		const data = method === 8 ? deflateRawSync(entry.body) : Buffer.from(entry.body);
		const name = Buffer.from(entry.name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(entry.flags ?? 0, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(entry.body.length, 22);
		local.writeUInt16LE(name.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(entry.flags ?? 0, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(entry.body.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, name, data);
		centrals.push(central, name);
		offset += local.length + name.length + data.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

describe('parseDmarcReport', () => {
	it('reads a real-world aggregate report', () => {
		const result = parseDmarcReport(fixture);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.report).toMatchObject({
			reporterOrgName: 'google.com',
			reporterEmail: 'noreply-dmarc-support@google.com',
			reportId: '15739436270285651457',
			rangeBeginMs: 1790726400 * 1000,
			rangeEndMs: 1790812799 * 1000,
			policyDomain: 'example.com',
			publishedPolicy: 'none',
			publishedSubdomainPolicy: 'none',
			publishedPct: 100,
		});
		expect(result.report.records).toHaveLength(3);
		expect(result.report.records[0]).toEqual({
			sourceIp: '203.0.113.10',
			count: 412,
			disposition: 'none',
			isDkimAligned: true,
			isSpfAligned: true,
			headerFrom: 'example.com',
			dkimResults: [{ domain: 'example.com', result: 'pass', detail: 's1790000000' }],
			spfResults: [{ domain: 'bounces.example.com', result: 'pass' }],
			overrideReasons: [],
		});
		expect(result.report.records[1]?.overrideReasons).toEqual(['forwarded']);
		expect(result.report.records[2]).toMatchObject({ isDkimAligned: false, isSpfAligned: false });
	});

	it('refuses a DTD, so external entities can never be fetched or expanded', () => {
		const xxe = `<?xml version="1.0"?><!DOCTYPE feedback [<!ENTITY x SYSTEM "file:///etc/passwd">]><feedback>&x;</feedback>`;
		expect(parseDmarcReport(xxe)).toEqual({
			ok: false,
			error: 'document type declarations are not allowed',
		});
	});

	it('leaves unknown entities as literal text and decodes the predefined ones', () => {
		const parsed = parseDmarcXml('<a><b>&amp;&lt;&#65;&#x42;&nope;</b></a>', {
			maxElements: 10,
			maxDepth: 4,
		});
		expect(parsed.ok && parsed.root.children[0]?.text).toBe('&<AB&nope;');
	});

	it('rejects documents that are not aggregate reports or are malformed', () => {
		expect(parseDmarcReport('<other/>').ok).toBe(false);
		expect(parseDmarcReport('<feedback><report_metadata>').ok).toBe(false);
		const noId = fixture.replace('15739436270285651457', '');
		expect(parseDmarcReport(noId)).toEqual({ ok: false, error: 'invalid report_id' });
		expect(parseDmarcReport(fixture.replace('<begin>1790726400', '<begin>1890726400')).ok).toBe(
			false
		);
	});

	it('caps the record count and the nesting depth', () => {
		const record = /<record>[\s\S]*?<\/record>/.exec(fixture)?.[0] ?? '';
		const many = fixture.replace(record, record.repeat(DMARC_REPORT_MAX_RECORDS + 1));
		expect(parseDmarcReport(many)).toEqual({ ok: false, error: 'too many records' });
		const deep = `<feedback>${'<x>'.repeat(40)}${'</x>'.repeat(40)}</feedback>`;
		expect(parseDmarcReport(deep)).toEqual({ ok: false, error: 'nesting too deep' });
	});

	it('drops unreadable and empty rows instead of failing the report', () => {
		const bad = fixture
			.replace('<source_ip>198.51.100.77</source_ip>', '<source_ip>not-an-ip</source_ip>')
			.replace('<count>37</count>', '<count>0</count>');
		const result = parseDmarcReport(bad);
		expect(result.ok && result.report.records.map((r) => r.sourceIp)).toEqual(['203.0.113.10']);
	});
});

describe('containers', () => {
	it('sniffs gzip, zip and raw XML by their bytes', () => {
		expect(sniffDmarcReportContainer(new Uint8Array([0x1f, 0x8b, 8]))).toBe('gzip');
		expect(sniffDmarcReportContainer(zip([{ name: 'r.xml', body: new Uint8Array([60]) }]))).toBe(
			'zip'
		);
		expect(sniffDmarcReportContainer(new TextEncoder().encode('﻿  <?xml?>'))).toBe('xml');
		expect(sniffDmarcReportContainer(new TextEncoder().encode('hello'))).toBe('unknown');
	});

	it('finds the XML entry of a zip', () => {
		const body = new TextEncoder().encode(fixture);
		const archive = zip([
			{ name: 'readme.txt', body: new Uint8Array([1, 2, 3]), method: 0 },
			{ name: 'google.com!example.com!1790726400!1790812799.xml', body },
		]);
		const located = locateZipXmlEntry(archive);
		expect(located.ok).toBe(true);
		if (!located.ok) return;
		expect(located.entry.method).toBe(8);
		expect(located.entry.uncompressedSize).toBe(body.length);
	});

	it('refuses encrypted entries, too many entries and archives without XML', () => {
		const body = new Uint8Array([60]);
		expect(locateZipXmlEntry(zip([{ name: 'r.xml', body, flags: 1 }])).ok).toBe(false);
		const crowd = Array.from({ length: DMARC_REPORT_MAX_ZIP_ENTRIES + 1 }, (_, i) => ({
			name: `r${i}.xml`,
			body,
		}));
		expect(locateZipXmlEntry(zip(crowd))).toEqual({ ok: false, error: 'zip: too many entries' });
		expect(locateZipXmlEntry(zip([{ name: 'r.txt', body }]))).toEqual({
			ok: false,
			error: 'zip: no XML report inside',
		});
		expect(locateZipXmlEntry(new Uint8Array(10)).ok).toBe(false);
	});
});
