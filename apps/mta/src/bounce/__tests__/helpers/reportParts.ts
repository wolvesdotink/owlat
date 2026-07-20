/**
 * Shared test helper: derive the scraper report-parts from a fabricated
 * `ParsedMessage` mock's `attachments`.
 *
 * In production the report parts are walked out of the raw MIME by
 * `extractReportParts`; the mock-driven bounce/FBL unit tests instead fabricate
 * them from the mock's `attachments` so the existing `{ content, contentType }`
 * fixtures keep driving the delivery-status / feedback-report / header-scrape
 * paths. Extracted here so the parser / fblProcessor / verpForgedDsn suites share
 * one definition instead of a character-for-character triplicate.
 */

import type { ParsedMessage } from '@owlat/mail-message';
import type { ReportPart } from '../../reportParts.js';

/** A fabricated attachment carries at least the two fields the scrapers read. */
interface MockAttachment {
	contentType?: string;
	content?: Buffer;
}

/** Map a mock's `attachments` onto the `ReportPart` shape the scrapers consume. */
export function reportPartsOf(parsed: ParsedMessage): ReportPart[] {
	const atts = (parsed as unknown as { attachments?: ReadonlyArray<MockAttachment> }).attachments;
	return (atts ?? []).map((a) => ({
		contentType: (a.contentType ?? '').toLowerCase(),
		content: a.content ?? Buffer.alloc(0),
	}));
}
