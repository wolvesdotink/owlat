/**
 * The AI text an Answer mode composer last wrote into its body, streamed or
 * applied, keyed by the composer's `bodyHtml` ref (the one ref the answer API
 * and the autosave both hold).
 *
 * The autosave tags a write with it while the body's written part is still
 * exactly that text, so the server records the change as the AI's and not a
 * person's: a draft no person touched may be cleaned up once the conversation
 * is answered (#1346, apps/api/convex/mail/draftProvenance.ts). The moment a
 * person changes the written part the tag stops, and the server marks the
 * draft as theirs.
 */
import type { Ref } from 'vue';
import { aiTextToHtml, splitAnswerBody } from '@owlat/shared/answerMode';

const written = new WeakMap<Ref<string>, string>();

/** Record (or, with null, forget) the AI text just written into `body`. */
export function setAiWrittenText(body: Ref<string>, text: string | null): void {
	if (text === null) written.delete(body);
	else written.set(body, text);
}

/** The AI text `html` (default: the body as it is now) still holds verbatim, if any. */
export function aiWrittenTextOf(body: Ref<string>, html: string = body.value): string | undefined {
	const text = written.get(body);
	if (text === undefined) return undefined;
	const expected = aiTextToHtml(text);
	return expected !== '' && splitAnswerBody(html).fresh.trim() === expected ? text : undefined;
}
