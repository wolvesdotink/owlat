/**
 * `@owlat/mail-message` — the in-house RFC 5322 / MIME message parser that
 * replaces mailparser on Owlat's inbound path.
 *
 * P1 lands the header engine: the relocated RFC 2047 / 2231 header helpers, a
 * structured header map, structured Content-Type/Disposition parsing, RFC 5322
 * date parsing, and the AddressObject layer. P2 adds MIME part-tree assembly,
 * per-part charset decoding and document-order attachment extraction. The
 * `parseMessage` facade (P3) builds on this surface.
 */

export {
	unfold,
	decodeQpHexEscapes,
	decodeEncodedWords,
	decodeHeaderValue,
	decodeRfc2231,
	splitHeaderLines,
	parseStructuredHeader,
	parseHeaders,
	MessageHeaders,
	type StructuredHeader,
} from './parse/headers';

export { parseContentType, getBoundary, isMultipart, type ContentType } from './parse/contentType';

export { parseDate } from './parse/date';

export {
	parseAddressList,
	parseAddressObject,
	parseAddressObjects,
	formatAddress,
	formatAddressList,
	type EmailAddress,
	type AddressObject,
} from './parse/address';

export { decodeCharset, normalizeCharset } from './parse/charset';

export {
	parseMimeTree,
	walkLeaves,
	partFilename,
	partDisposition,
	isAttachmentPart,
	transferDecode,
	assembleBody,
	parseBody,
	type MimeNode,
	type AssembledBody,
} from './parse/body';

export {
	extractAttachments,
	extractAttachmentsFromTree,
	type MessageAttachment,
} from './parse/attachments';
