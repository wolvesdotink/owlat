/**
 * TLS-RPT (SMTP TLS Reporting, RFC 8460) inbound report parsing.
 *
 * We publish a `_smtp._tls` `rua=` address (see the MTA + the operator's own
 * DNS record) which asks other mail servers to send us daily aggregate reports
 * about TLS negotiation when they deliver mail TO us. Those reports arrive as
 * gzip-compressed JSON (media type `application/tlsrpt+gzip`). This module is
 * the reciprocal of `apps/mta/src/smtp/tlsRpt.ts` (which *generates* the same
 * shape for domains we send to): it gunzips and validates an inbound report
 * without ever throwing, so a malformed or oversized upload can never crash the
 * ingestion path.
 *
 * Pure + dependency-free. The gunzip step uses the WHATWG `DecompressionStream`,
 * which is a Node/browser global but is NOT in Convex's default (V8 isolate)
 * runtime API surface — so the Convex ingest path routes the decode through a
 * `'use node'` internal action (`domains/tlsReportsNode.ts`), never the isolate.
 * The pure `parseTlsReport`/`digestTlsReport` half runs anywhere. This module is
 * the single source of truth for the report schema.
 */

// ─── RFC 8460 report shape ──────────────────────────────────────────

/** Policy block echoed in a report (RFC 8460 §4.4). */
export interface TlsRptPolicy {
	'policy-type': string;
	'policy-string': string[];
	'policy-domain': string;
	'mx-host'?: string[];
}

/** Per-failure detail block (RFC 8460 §4.4). */
export interface TlsRptFailureDetail {
	'result-type': string;
	'sending-mta-ip': string;
	'receiving-mx-hostname': string;
	'receiving-ip'?: string;
	'failed-session-count': number;
	'additional-information'?: string;
}

/** One policy's summary + failures. */
export interface TlsRptPolicyBlock {
	policy: TlsRptPolicy;
	summary: {
		'total-successful-session-count': number;
		'total-failure-session-count': number;
	};
	'failure-details'?: TlsRptFailureDetail[];
}

/** A full RFC 8460 aggregate report. */
export interface TlsRptReport {
	'organization-name': string;
	'date-range': {
		'start-datetime': string;
		'end-datetime': string;
	};
	'contact-info': string;
	'report-id': string;
	policies: TlsRptPolicyBlock[];
}

/** Discriminated parse outcome — never thrown, always returned. */
export type TlsReportParseResult =
	| { ok: true; report: TlsRptReport }
	| { ok: false; error: string };

// ─── Size guards (defense against zip bombs / abuse) ────────────────

/** Max compressed upload we will even attempt to gunzip. */
export const TLS_RPT_MAX_COMPRESSED_BYTES = 1024 * 1024; // 1 MiB
/** Max decompressed JSON we will hold in memory before rejecting. */
export const TLS_RPT_MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024; // 16 MiB
export const TLS_RPT_MAX_FAILURE_TYPES = 64;
/** Per-report session ceiling; keeps stored and 5,000-row dashboard sums exact. */
export const TLS_RPT_MAX_SESSION_COUNT = 1_000_000_000;
export const TLS_RPT_MAX_REPORT_ID_LENGTH = 512;
export const TLS_RPT_MAX_ORGANIZATION_NAME_LENGTH = 256;
export const TLS_RPT_MAX_CONTACT_INFO_LENGTH = 2_048;
export const TLS_RPT_MAX_POLICY_DOMAIN_LENGTH = 253;
export const TLS_RPT_MAX_FAILURE_TYPE_LENGTH = 128;
const TLS_RPT_MAX_POLICY_TYPE_LENGTH = 64;
const TLS_RPT_MAX_DATE_LENGTH = 64;

// ─── Gunzip ─────────────────────────────────────────────────────────

/**
 * Gunzip a compressed TLS-RPT upload to its JSON text, enforcing both an input
 * and a decompressed-output size cap. Rejects (rather than throws) via a thrown
 * `Error` only for genuinely corrupt gzip — callers should pass the result to a
 * try/catch or use {@link decodeTlsReport} which folds this in.
 */
export async function gunzipTlsReport(bytes: Uint8Array): Promise<string> {
	if (bytes.byteLength > TLS_RPT_MAX_COMPRESSED_BYTES) {
		throw new Error('tls-rpt: compressed payload too large');
	}
	const stream = new DecompressionStream('gzip');
	const writer = stream.writable.getWriter();
	// The real gunzip error surfaces on the reader for corrupt input; swallow the
	// writer-side rejection so it isn't reported as an unhandled rejection.
	// Cast to `Uint8Array<ArrayBuffer>` (not the DOM-only `BufferSource` name,
	// which is undefined under the MTA/IMAP `lib: ES2022` builds) — a concrete
	// typed array is assignable to the writer's chunk type in every tree.
	writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => undefined);
	writer.close().catch(() => undefined);

	const reader = stream.readable.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			total += value.byteLength;
			if (total > TLS_RPT_MAX_DECOMPRESSED_BYTES) {
				throw new Error('tls-rpt: decompressed payload too large');
			}
			chunks.push(value);
		}
	}

	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder('utf-8').decode(merged);
}

// ─── Validation ─────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(
	value: unknown,
	maxLength: number,
	isEmptyAllowed = true
): value is string {
	return (
		typeof value === 'string' && value.length <= maxLength && (isEmptyAllowed || value.length > 0)
	);
}

function isSessionCount(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= TLS_RPT_MAX_SESSION_COUNT
	);
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === 'string');
}

function parsePolicy(raw: unknown): TlsRptPolicy | null {
	if (!isRecord(raw)) return null;
	const policyType = raw['policy-type'];
	const policyDomain = raw['policy-domain'];
	if (
		!isBoundedString(policyType, TLS_RPT_MAX_POLICY_TYPE_LENGTH, false) ||
		!isBoundedString(policyDomain, TLS_RPT_MAX_POLICY_DOMAIN_LENGTH, false)
	) {
		return null;
	}
	const policy: TlsRptPolicy = {
		'policy-type': policyType,
		'policy-string': asStringArray(raw['policy-string']),
		'policy-domain': policyDomain,
	};
	const mxHost = asStringArray(raw['mx-host']);
	if (mxHost.length > 0) policy['mx-host'] = mxHost;
	return policy;
}

function parseFailureDetail(raw: unknown): TlsRptFailureDetail | null {
	if (!isRecord(raw)) return null;
	const resultType = raw['result-type'];
	const failedCount = raw['failed-session-count'];
	if (!isBoundedString(resultType, TLS_RPT_MAX_FAILURE_TYPE_LENGTH, false)) return null;
	if (!isSessionCount(failedCount)) return null;
	const detail: TlsRptFailureDetail = {
		'result-type': resultType,
		'sending-mta-ip': typeof raw['sending-mta-ip'] === 'string' ? raw['sending-mta-ip'] : '',
		'receiving-mx-hostname':
			typeof raw['receiving-mx-hostname'] === 'string' ? raw['receiving-mx-hostname'] : '',
		'failed-session-count': failedCount,
	};
	if (typeof raw['receiving-ip'] === 'string') detail['receiving-ip'] = raw['receiving-ip'];
	if (typeof raw['additional-information'] === 'string') {
		detail['additional-information'] = raw['additional-information'];
	}
	return detail;
}

function parsePolicyBlock(raw: unknown): TlsRptPolicyBlock | null {
	if (!isRecord(raw)) return null;
	const policy = parsePolicy(raw['policy']);
	if (!policy) return null;
	const summary = raw['summary'];
	if (!isRecord(summary)) return null;
	const success = summary['total-successful-session-count'];
	const failure = summary['total-failure-session-count'];
	if (!isSessionCount(success) || !isSessionCount(failure)) return null;

	const block: TlsRptPolicyBlock = {
		policy,
		summary: {
			'total-successful-session-count': success,
			'total-failure-session-count': failure,
		},
	};

	if (Array.isArray(raw['failure-details'])) {
		const details = raw['failure-details']
			.map(parseFailureDetail)
			.filter((d): d is TlsRptFailureDetail => d !== null);
		if (details.length > 0) block['failure-details'] = details;
	}
	return block;
}

/**
 * Validate an already-decoded JSON string into a {@link TlsRptReport}. Never
 * throws — returns a discriminated result so callers branch instead of
 * try/catch. Rejects malformed JSON, missing required fields, and reports with
 * no usable policy blocks.
 */
export function parseTlsReport(json: string): TlsReportParseResult {
	if (new TextEncoder().encode(json).byteLength > TLS_RPT_MAX_DECOMPRESSED_BYTES) {
		return { ok: false, error: 'tls-rpt: JSON payload too large' };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return { ok: false, error: 'invalid JSON' };
	}
	if (!isRecord(raw)) return { ok: false, error: 'report is not an object' };

	const reportId = raw['report-id'];
	if (!isBoundedString(reportId, TLS_RPT_MAX_REPORT_ID_LENGTH, false)) {
		return { ok: false, error: 'invalid report-id' };
	}
	const orgName = raw['organization-name'];
	if (!isBoundedString(orgName, TLS_RPT_MAX_ORGANIZATION_NAME_LENGTH, false)) {
		return { ok: false, error: 'invalid organization-name' };
	}
	const dateRange = raw['date-range'];
	if (!isRecord(dateRange)) return { ok: false, error: 'missing date-range' };
	const start = dateRange['start-datetime'];
	const end = dateRange['end-datetime'];
	if (
		!isBoundedString(start, TLS_RPT_MAX_DATE_LENGTH, false) ||
		!isBoundedString(end, TLS_RPT_MAX_DATE_LENGTH, false)
	) {
		return { ok: false, error: 'invalid date-range' };
	}
	const startMs = Date.parse(start);
	const endMs = Date.parse(end);
	if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs > endMs) {
		return { ok: false, error: 'unparseable date-range' };
	}
	if (!Array.isArray(raw['policies'])) {
		return { ok: false, error: 'missing policies' };
	}
	const policies = raw['policies']
		.map(parsePolicyBlock)
		.filter((p): p is TlsRptPolicyBlock => p !== null);
	if (policies.length === 0) {
		return { ok: false, error: 'no valid policy blocks' };
	}
	let totalSuccess = 0;
	let totalFailure = 0;
	let totalDetailedFailures = 0;
	for (const policy of policies) {
		totalSuccess += policy.summary['total-successful-session-count'];
		totalFailure += policy.summary['total-failure-session-count'];
		for (const detail of policy['failure-details'] ?? []) {
			totalDetailedFailures += detail['failed-session-count'];
		}
		if (
			totalSuccess > TLS_RPT_MAX_SESSION_COUNT ||
			totalFailure > TLS_RPT_MAX_SESSION_COUNT ||
			totalDetailedFailures > TLS_RPT_MAX_SESSION_COUNT
		) {
			return { ok: false, error: 'session-count total is too large' };
		}
	}

	const contactInfo = raw['contact-info'];
	if (!isBoundedString(contactInfo, TLS_RPT_MAX_CONTACT_INFO_LENGTH)) {
		return { ok: false, error: 'invalid contact-info' };
	}
	return {
		ok: true,
		report: {
			'organization-name': orgName,
			'date-range': { 'start-datetime': start, 'end-datetime': end },
			'contact-info': contactInfo,
			'report-id': reportId,
			policies,
		},
	};
}

/**
 * Convenience: gunzip + parse in one step, folding both failure modes into the
 * discriminated result. Never throws.
 */
export async function decodeTlsReport(bytes: Uint8Array): Promise<TlsReportParseResult> {
	let json: string;
	try {
		json = await gunzipTlsReport(bytes);
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'gunzip failed' };
	}
	return parseTlsReport(json);
}

// ─── Aggregation helpers (schema-free, reused by backend + UI) ──────

/** Flattened per-report summary the backend persists + the UI aggregates. */
export interface TlsReportDigest {
	reportId: string;
	organizationName: string;
	contactInfo: string;
	policyDomain: string;
	rangeStartMs: number;
	rangeEndMs: number;
	successCount: number;
	failureCount: number;
	failureTypeCounts: Array<{ type: string; count: number }>;
}

/**
 * Reduce a parsed report to the flat digest we store. Sums session counts and
 * failure-type counts across every policy block. `policyDomain` is the first
 * reported receiving-policy domain; the reporting partner is identified by
 * `organizationName` instead.
 */
export function digestTlsReport(report: TlsRptReport): TlsReportDigest {
	let successCount = 0;
	let failureCount = 0;
	const failureTypes = new Map<string, number>();

	for (const block of report.policies) {
		successCount += block.summary['total-successful-session-count'];
		failureCount += block.summary['total-failure-session-count'];
		for (const detail of block['failure-details'] ?? []) {
			const rawType = detail['result-type'].slice(0, TLS_RPT_MAX_FAILURE_TYPE_LENGTH);
			const type =
				failureTypes.has(rawType) || failureTypes.size < TLS_RPT_MAX_FAILURE_TYPES - 1
					? rawType
					: 'other';
			const prev = failureTypes.get(type) ?? 0;
			failureTypes.set(type, prev + detail['failed-session-count']);
		}
	}

	return {
		reportId: report['report-id'],
		organizationName: report['organization-name'],
		contactInfo: report['contact-info'],
		policyDomain: report.policies[0]?.policy['policy-domain'] ?? 'unknown',
		rangeStartMs: Date.parse(report['date-range']['start-datetime']),
		rangeEndMs: Date.parse(report['date-range']['end-datetime']),
		successCount,
		failureCount,
		failureTypeCounts: Array.from(failureTypes.entries()).map(([type, count]) => ({
			type,
			count,
		})),
	};
}

// ─── Plain-language failure-type copy (human, no crypto jargon) ─────

/**
 * Plain-language explanation for each RFC 8460 `result-type`, for the delivery
 * dashboard. Kept alongside the parser so the wording stays consistent with the
 * report schema. Deliberately explains the *effect* ("STARTTLS stripped
 * upstream") rather than lecturing about the mechanism.
 */
export const TLS_RPT_FAILURE_EXPLANATIONS: Record<string, string> = {
	'starttls-not-supported': 'STARTTLS stripped upstream',
	'certificate-host-mismatch': "Certificate didn't match the server name",
	'certificate-expired': 'Server certificate had expired',
	'certificate-not-trusted': 'Server certificate was not trusted',
	'validation-failure': 'TLS validation failed',
	'tlsa-invalid': 'DANE (TLSA) record was invalid',
	'dnssec-invalid': 'DNSSEC validation failed',
	'dane-required': 'DANE was required but unavailable',
	'sts-policy-fetch-error': "Could not fetch the partner's MTA-STS policy",
	'sts-policy-invalid': "Partner's MTA-STS policy was invalid",
	'sts-webpki-invalid': "Certificate failed the partner's MTA-STS policy",
};

/** Human copy for a failure type, falling back to a readable form of the code. */
export function explainTlsFailureType(type: string): string {
	return TLS_RPT_FAILURE_EXPLANATIONS[type] ?? type.replace(/-/g, ' ');
}
