/**
 * `@owlat/mail-message` — the in-house RFC 5322 / MIME message library that
 * replaces both mailparser (inbound) and nodemailer's MIME builder (outbound)
 * on Owlat's mail path. It ships two collision-free halves behind one entry:
 *
 *  - parse side (`src/parse/*`): the RFC 5322 / MIME message parser — header
 *    engine, structured Content-Type/Disposition, RFC 5322 date parsing, the
 *    AddressObject layer, MIME part-tree assembly, per-part charset decoding
 *    and document-order attachment extraction. The `parseMessage` facade (P3)
 *    builds on this surface.
 *  - compose side (`src/compose/*`): pure
 *    RFC 5322 / RFC 2045 message construction with zero runtime dependencies
 *    beyond `node:crypto`, so it stays safe to import from a Convex `'use node'`
 *    action. nodemailer / mailparser survive only as devDependencies for
 *    differential and golden tests.
 */

// --- parse side ---
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
	assembleBody,
	parseBody,
	walkLeaves,
	transferDecode,
	isAttachmentPart,
	partFilename,
	partDisposition,
	type MimeNode,
	type AssembledBody,
} from './parse/body';

export { extractAttachments, type MessageAttachment } from './parse/attachments';

export { parseMessage, type ParsedMessage, type ParsedHeaderValue } from './parse/index';

// --- compose side ---
export {
	escapeHeader,
	encodeHeaderValue,
	encodeAddressHeader,
	safeAttachmentFilename,
} from './compose/headers';
export { randomBoundary, quotedPrintableEncode, encodeTextBody } from './compose/encoding';
export { buildMessageId } from './compose/messageId';
export {
	buildRfc822,
	composeMessage,
	stripHtml,
	type ComposeInput,
	type ComposeAttachment,
	type ComposeMessageInput,
	type ComposedMessage,
} from './compose/compose';
export { signMessage, buildDkimSignatureLine, type DkimSigningKey } from './compose/dkim';
