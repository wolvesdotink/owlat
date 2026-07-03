/**
 * Pure helper for the composer's "you said 'attached' but forgot to attach it"
 * guard. Framework-free so it's unit-testable without a component mount.
 */

const ATTACHMENT_HINT = /\b(attach(ed|ment|ing|ments)?|enclosed)\b/i;

/**
 * True when the subject or body prose mentions an attachment. HTML tags in the
 * body are stripped to bare text first so tag names/attributes never match.
 */
export function mentionsAttachment(subject: string, bodyHtml: string): boolean {
	const text = `${subject} ${bodyHtml.replace(/<[^>]+>/g, ' ')}`;
	return ATTACHMENT_HINT.test(text);
}
