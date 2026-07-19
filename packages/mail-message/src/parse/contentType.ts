/**
 * Structured `Content-Type` / `Content-Disposition` parsing on top of the RFC
 * 2231 / RFC 2047 param machinery in `headers.ts`.
 */

import { parseStructuredHeader, type StructuredHeader } from './headers';

export { parseStructuredHeader };
export type { StructuredHeader };

/** A `Content-Type` split into its type/subtype plus structured params. */
export interface ContentType extends StructuredHeader {
	/** Top-level type, lowercased (e.g. `multipart`, `text`). */
	type: string;
	/** Subtype, lowercased (e.g. `mixed`, `plain`). Empty when absent. */
	subtype: string;
}

/**
 * Parse a `Content-Type` header value. Absent/blank input yields the RFC 2045
 * default `text/plain`. `value` is the full lowercased `type/subtype`; `type`
 * and `subtype` are the split halves; `params` carries `boundary`, `charset`,
 * `report-type`, etc. with continuations/encoded-words already decoded.
 */
export function parseContentType(raw: string | undefined): ContentType {
	const structured = parseStructuredHeader(raw);
	const value = structured.value || 'text/plain';
	const slash = value.indexOf('/');
	const type = slash < 0 ? value : value.slice(0, slash);
	const subtype = slash < 0 ? '' : value.slice(slash + 1);
	return { value, type, subtype, params: structured.params };
}

/** The `boundary` param of a multipart `Content-Type`, or `undefined`. */
export function getBoundary(raw: string | undefined): string | undefined {
	const boundary = parseContentType(raw).params['boundary'];
	return boundary === undefined || boundary === '' ? undefined : boundary;
}

/** Whether a `Content-Type` names a `multipart/*` container. */
export function isMultipart(raw: string | undefined): boolean {
	return parseContentType(raw).type === 'multipart';
}
