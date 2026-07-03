/**
 * "Forgot the attachment?" detection for the Postbox composer: does the draft's
 * subject or body mention attaching/enclosing something? Pure and HTML-aware
 * (tags are stripped before matching) so it stays unit-testable in isolation.
 */
const ATTACHMENT_HINT = /\b(attach(ed|ment|ing|ments)?|enclosed)\b/i;

/** Whether the subject or (tag-stripped) body HTML mentions an attachment. */
export function mentionsAttachment(subject: string, bodyHtml: string): boolean {
	const text = `${subject} ${bodyHtml.replace(/<[^>]+>/g, ' ')}`;
	return ATTACHMENT_HINT.test(text);
}
