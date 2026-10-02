/**
 * DMARC aggregate (RUA) report parsing — RFC 7489 Appendix C.
 *
 * Receivers mail us one report per policy domain per day, as XML that is
 * usually gzipped (`.xml.gz`) or zipped (`.zip`). This module is the pure half
 * of the intake: it sniffs which of the three containers a payload is, finds
 * the XML entry inside a zip, and turns the XML into the flat shape the backend
 * stores. Decompression itself happens in the Convex Node action
 * (`domains/dmarcReportsNode.ts`), which has `node:zlib` and its output cap.
 *
 * Every input is hostile until proven otherwise: the report address is a
 * public mailbox. So every size is capped (compressed bytes, XML bytes, zip
 * entries, elements, records, string lengths, counts), the XML reader refuses
 * DTDs and entities (see `./dmarcReportXml`), and nothing here throws — a bad
 * report is a `{ ok: false, error }` the caller acknowledges and drops.
 */

import { parseDmarcXml, xmlChild, xmlChildren, xmlText, type XmlElement } from './dmarcReportXml';
import { normalizeIpAddress } from './ipAddress';

// ─── Limits ─────────────────────────────────────────────────────────

/** Largest compressed attachment we will try to open. */
export const DMARC_REPORT_MAX_COMPRESSED_BYTES = 5 * 1024 * 1024;
/** Largest XML document (after decompression) we will parse. */
export const DMARC_REPORT_MAX_XML_BYTES = 8 * 1024 * 1024;
/** A zip holding more entries than this is not a DMARC report. */
const DMARC_REPORT_MAX_ZIP_ENTRIES = 16;
/** Rows (`<record>` elements) one report may carry. */
export const DMARC_REPORT_MAX_RECORDS = 5_000;
/** Per-row message count ceiling; keeps sums exact in a 20,000-row read. */
export const DMARC_REPORT_MAX_ROW_COUNT = 100_000_000;

const MAX_ELEMENTS = DMARC_REPORT_MAX_RECORDS * 40 + 200;
const MAX_DEPTH = 16;
const MAX_ORG_NAME_LENGTH = 256;
const MAX_REPORT_ID_LENGTH = 512;
const MAX_EMAIL_LENGTH = 320;
const MAX_DOMAIN_LENGTH = 253;
const MAX_SELECTOR_LENGTH = 128;
const MAX_RESULT_LENGTH = 32;
const MAX_AUTH_RESULTS = 4;
const MAX_REASONS = 4;
/** A report period longer than this is not a daily aggregate report. */
const MAX_RANGE_SECONDS = 31 * 24 * 60 * 60;

// ─── Parsed shape ───────────────────────────────────────────────────

export type DmarcPolicyValue = 'none' | 'quarantine' | 'reject';

export interface DmarcAuthResult {
	domain: string;
	result: string;
	/** DKIM selector or SPF scope, when the reporter gave one. */
	detail?: string;
}

export interface DmarcReportRecord {
	sourceIp: string;
	count: number;
	disposition: DmarcPolicyValue;
	/** DMARC-aligned DKIM pass (`policy_evaluated/dkim`). */
	isDkimAligned: boolean;
	/** DMARC-aligned SPF pass (`policy_evaluated/spf`). */
	isSpfAligned: boolean;
	headerFrom: string;
	envelopeFrom?: string;
	dkimResults: DmarcAuthResult[];
	spfResults: DmarcAuthResult[];
	/** `policy_evaluated/reason/type` values, e.g. `forwarded`, `mailing_list`. */
	overrideReasons: string[];
}

export interface DmarcReport {
	reporterOrgName: string;
	reporterEmail?: string;
	reportId: string;
	rangeBeginMs: number;
	rangeEndMs: number;
	policyDomain: string;
	publishedPolicy?: DmarcPolicyValue;
	publishedSubdomainPolicy?: DmarcPolicyValue;
	publishedPct?: number;
	records: DmarcReportRecord[];
}

export type DmarcReportParseResult =
	| { ok: true; report: DmarcReport }
	| { ok: false; error: string };

// ─── Container sniffing ─────────────────────────────────────────────

export type DmarcReportContainer = 'gzip' | 'zip' | 'xml' | 'unknown';

function isXmlWhitespace(byte: number | undefined): boolean {
	return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/** Which container a payload is, by its magic bytes (filenames lie). */
export function sniffDmarcReportContainer(bytes: Uint8Array): DmarcReportContainer {
	if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
	if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
		return 'zip';
	}
	let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
	while (i < 64 && isXmlWhitespace(bytes[i])) i++;
	return bytes[i] === 0x3c ? 'xml' : 'unknown';
}

/** The compressed XML entry inside a zip, ready for raw inflate (method 8) or as-is (method 0). */
export interface ZipXmlEntry {
	method: 0 | 8;
	data: Uint8Array;
	uncompressedSize: number;
}

export type ZipLocateResult = { ok: true; entry: ZipXmlEntry } | { ok: false; error: string };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

/**
 * Find the first `.xml` entry of a zip archive from its central directory.
 * Refuses encrypted entries, ZIP64, methods other than store/deflate, more than
 * {@link DMARC_REPORT_MAX_ZIP_ENTRIES} entries and a declared size over
 * {@link DMARC_REPORT_MAX_XML_BYTES}. The inflate step must still cap its own
 * output: a declared size is the sender's claim, not a fact.
 */
export function locateZipXmlEntry(bytes: Uint8Array): ZipLocateResult {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u16 = (at: number) => view.getUint16(at, true);
	const u32 = (at: number) => view.getUint32(at, true);

	let eocd = -1;
	const lowest = Math.max(0, bytes.byteLength - 22 - 0xffff);
	for (let at = bytes.byteLength - 22; at >= lowest; at--) {
		if (u32(at) === EOCD_SIGNATURE) {
			eocd = at;
			break;
		}
	}
	if (eocd < 0) return { ok: false, error: 'zip: no end of central directory' };

	const entryCount = u16(eocd + 10);
	const directoryOffset = u32(eocd + 16);
	if (entryCount === 0) return { ok: false, error: 'zip: empty archive' };
	if (entryCount > DMARC_REPORT_MAX_ZIP_ENTRIES)
		return { ok: false, error: 'zip: too many entries' };
	if (directoryOffset === ZIP64_MARKER) return { ok: false, error: 'zip: ZIP64 is not supported' };

	let at = directoryOffset;
	for (let index = 0; index < entryCount; index++) {
		if (at + 46 > bytes.byteLength || u32(at) !== CENTRAL_SIGNATURE) {
			return { ok: false, error: 'zip: corrupt central directory' };
		}
		const flags = u16(at + 8);
		const method = u16(at + 10);
		const compressedSize = u32(at + 20);
		const uncompressedSize = u32(at + 24);
		const nameLength = u16(at + 28);
		const extraLength = u16(at + 30);
		const commentLength = u16(at + 32);
		const localOffset = u32(at + 42);
		if (at + 46 + nameLength > bytes.byteLength)
			return { ok: false, error: 'zip: corrupt entry name' };
		const name = new TextDecoder('utf-8').decode(bytes.subarray(at + 46, at + 46 + nameLength));
		at += 46 + nameLength + extraLength + commentLength;

		if (!name.toLowerCase().endsWith('.xml') || name.endsWith('/')) continue;
		if (flags & 0x1) return { ok: false, error: 'zip: encrypted entries are not supported' };
		if (method !== 0 && method !== 8) return { ok: false, error: 'zip: unsupported compression' };
		if (
			compressedSize === ZIP64_MARKER ||
			uncompressedSize === ZIP64_MARKER ||
			localOffset === ZIP64_MARKER
		) {
			return { ok: false, error: 'zip: ZIP64 is not supported' };
		}
		if (uncompressedSize > DMARC_REPORT_MAX_XML_BYTES) {
			return { ok: false, error: 'zip: report is too large' };
		}
		if (localOffset + 30 > bytes.byteLength || u32(localOffset) !== LOCAL_SIGNATURE) {
			return { ok: false, error: 'zip: corrupt local header' };
		}
		const dataStart = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
		const dataEnd = dataStart + compressedSize;
		if (dataEnd > bytes.byteLength) return { ok: false, error: 'zip: truncated entry' };
		return {
			ok: true,
			entry: { method, data: bytes.subarray(dataStart, dataEnd), uncompressedSize },
		};
	}
	return { ok: false, error: 'zip: no XML report inside' };
}

// ─── XML → report ───────────────────────────────────────────────────

function boundedText(element: XmlElement | undefined, name: string, max: number): string | null {
	const text = xmlText(element, name);
	return text.length > 0 && text.length <= max ? text : null;
}

function asPolicy(value: string): DmarcPolicyValue | undefined {
	const lower = value.toLowerCase();
	return lower === 'none' || lower === 'quarantine' || lower === 'reject' ? lower : undefined;
}

const DOMAIN_RE = /^[a-z0-9_](?:[a-z0-9_.-]{0,251}[a-z0-9])?$/;

function asDomain(value: string): string | null {
	const lower = value.trim().toLowerCase().replace(/\.$/, '');
	return lower.length <= MAX_DOMAIN_LENGTH && DOMAIN_RE.test(lower) ? lower : null;
}

function parseAuthResults(parent: XmlElement | undefined, kind: 'dkim' | 'spf'): DmarcAuthResult[] {
	const results: DmarcAuthResult[] = [];
	for (const element of xmlChildren(parent, kind)) {
		if (results.length >= MAX_AUTH_RESULTS) break;
		const domain = asDomain(xmlText(element, 'domain'));
		const result = xmlText(element, 'result').toLowerCase();
		if (!domain || !result || result.length > MAX_RESULT_LENGTH) continue;
		const detail = xmlText(element, kind === 'dkim' ? 'selector' : 'scope');
		results.push({
			domain,
			result,
			...(detail && detail.length <= MAX_SELECTOR_LENGTH ? { detail } : {}),
		});
	}
	return results;
}

/** One `<record>` row, or null when it is unreadable or counts no messages. */
function parseRecord(element: XmlElement): DmarcReportRecord | null {
	const row = xmlChild(element, 'row');
	// Canonical form (RFC 5952 for IPv6), so a reporter's spelling cannot split
	// one source in two or hide our own pool IPs, and reverse DNS compares the
	// same string `dns.resolve6` returns.
	const sourceIpText = xmlText(row, 'source_ip');
	const sourceIp = sourceIpText.length <= 64 ? normalizeIpAddress(sourceIpText) : null;
	if (!sourceIp) return null;
	const countText = xmlText(row, 'count');
	if (!/^\d{1,12}$/.test(countText)) return null;
	const count = Number(countText);
	if (count > DMARC_REPORT_MAX_ROW_COUNT) return null;
	if (count === 0) return null;

	const evaluated = xmlChild(row, 'policy_evaluated');
	const identifiers = xmlChild(element, 'identifiers');
	const headerFrom = asDomain(xmlText(identifiers, 'header_from'));
	if (!headerFrom) return null;
	const envelopeFrom = asDomain(xmlText(identifiers, 'envelope_from'));
	const overrideReasons = xmlChildren(evaluated, 'reason')
		.map((reason) => xmlText(reason, 'type').toLowerCase())
		.filter((type) => type.length > 0 && type.length <= MAX_RESULT_LENGTH)
		.slice(0, MAX_REASONS);
	const authResults = xmlChild(element, 'auth_results');

	return {
		sourceIp,
		count,
		disposition: asPolicy(xmlText(evaluated, 'disposition')) ?? 'none',
		isDkimAligned: xmlText(evaluated, 'dkim').toLowerCase() === 'pass',
		isSpfAligned: xmlText(evaluated, 'spf').toLowerCase() === 'pass',
		headerFrom,
		...(envelopeFrom ? { envelopeFrom } : {}),
		dkimResults: parseAuthResults(authResults, 'dkim'),
		spfResults: parseAuthResults(authResults, 'spf'),
		overrideReasons,
	};
}

/** Parse a DMARC aggregate report from its XML text. Never throws. */
export function parseDmarcReport(xml: string): DmarcReportParseResult {
	if (xml.length > DMARC_REPORT_MAX_XML_BYTES) return { ok: false, error: 'report is too large' };
	const parsed = parseDmarcXml(xml, { maxElements: MAX_ELEMENTS, maxDepth: MAX_DEPTH });
	if (!parsed.ok) return parsed;
	const feedback = parsed.root;
	if (feedback.name !== 'feedback') return { ok: false, error: 'not a DMARC aggregate report' };

	const metadata = xmlChild(feedback, 'report_metadata');
	const reporterOrgName = boundedText(metadata, 'org_name', MAX_ORG_NAME_LENGTH);
	if (!reporterOrgName) return { ok: false, error: 'invalid org_name' };
	const reportId = boundedText(metadata, 'report_id', MAX_REPORT_ID_LENGTH);
	if (!reportId) return { ok: false, error: 'invalid report_id' };
	const reporterEmail = boundedText(metadata, 'email', MAX_EMAIL_LENGTH) ?? undefined;

	const range = xmlChild(metadata, 'date_range');
	const beginText = xmlText(range, 'begin');
	const endText = xmlText(range, 'end');
	if (!/^\d{1,11}$/.test(beginText) || !/^\d{1,11}$/.test(endText)) {
		return { ok: false, error: 'invalid date_range' };
	}
	const begin = Number(beginText);
	const end = Number(endText);
	if (begin > end || end - begin > MAX_RANGE_SECONDS) {
		return { ok: false, error: 'invalid date_range' };
	}

	const published = xmlChild(feedback, 'policy_published');
	const policyDomain = asDomain(xmlText(published, 'domain'));
	if (!policyDomain) return { ok: false, error: 'invalid policy domain' };
	const pctText = xmlText(published, 'pct');
	const publishedPct =
		/^\d{1,3}$/.test(pctText) && Number(pctText) <= 100 ? Number(pctText) : undefined;
	const publishedPolicy = asPolicy(xmlText(published, 'p'));
	const publishedSubdomainPolicy = asPolicy(xmlText(published, 'sp'));

	const recordElements = xmlChildren(feedback, 'record');
	if (recordElements.length > DMARC_REPORT_MAX_RECORDS) {
		return { ok: false, error: 'too many records' };
	}
	// A row we cannot read (no source IP, no header_from) is dropped rather than
	// failing the whole report: one reporter's odd row should not cost the day.
	const records: DmarcReportRecord[] = [];
	for (const element of recordElements) {
		const record = parseRecord(element);
		if (record) records.push(record);
	}
	if (recordElements.length > 0 && records.length === 0) {
		return { ok: false, error: 'no readable records' };
	}

	return {
		ok: true,
		report: {
			reporterOrgName,
			...(reporterEmail ? { reporterEmail } : {}),
			reportId,
			rangeBeginMs: begin * 1000,
			rangeEndMs: end * 1000,
			policyDomain,
			...(publishedPolicy ? { publishedPolicy } : {}),
			...(publishedSubdomainPolicy ? { publishedSubdomainPolicy } : {}),
			...(publishedPct !== undefined ? { publishedPct } : {}),
			records,
		},
	};
}
