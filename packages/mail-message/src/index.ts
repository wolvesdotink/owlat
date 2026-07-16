/**
 * @owlat/mail-message — pure RFC 5322 / RFC 2045 message construction.
 *
 * Zero runtime dependencies beyond `node:crypto`, so the package stays safe to
 * import from a Convex `'use node'` action. nodemailer / mailparser survive
 * only as devDependencies for differential and golden tests.
 */

export {
	escapeHeader,
	encodeHeaderValue,
	encodeAddressHeader,
	safeAttachmentFilename,
} from './headers';
export { randomBoundary, quotedPrintableEncode, encodeTextBody } from './encoding';
export { buildMessageId } from './messageId';
export { buildRfc822, stripHtml, type ComposeInput, type ComposeAttachment } from './compose';
