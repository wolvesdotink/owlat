/**
 * Saved replies in the Team inbox reply ({@link ThreadComposer}): the `;`
 * trigger typed into its textarea, the footer picker and palette rows
 * (`useComposerSavedReplyPicker`), and the prompt-on-insert dialog.
 *
 * The reply is plain text, so a reply's HTML is resolved as in the Postbox
 * (same variables, same gaps) and then turned into text at insertion. The
 * recipient's facts come from the thread's contact; `{{me.*}}` is the person
 * writing.
 *
 * A reply that leaves `[[...]]` gaps marks the composer gap-guarded: its gaps
 * hold Send like an AI draft's do (`useTeamComposerGaps`).
 */

import type { Ref } from 'vue';
import { htmlToPlainText } from '@owlat/shared/html';
import type {
	EditorSnippet,
	SnippetPromptRequest,
} from '~/composables/postbox/usePostboxSnippetPicker';
import { useComposerSavedReplies } from '~/composables/useSavedReplies';
import { useComposerSavedReplyPicker } from '~/composables/useComposerSavedReplyPicker';
import { aiTextToHtml } from '~/utils/answerDraft';
import {
	detectSnippetTrigger,
	firstNameOf,
	rankSnippets,
	threadSubjectOf,
	type SnippetTrigger,
} from '~/utils/postboxSnippets';
import {
	promptedSnippetVariables,
	resolveSnippetBody,
	snippetVariableSourceKey,
	type SnippetVariableContext,
} from '~/utils/postboxSnippetVariables';
import { textareaCaretOffset } from '~/utils/textareaCaret';

/** Who a Team inbox reply goes to, as far as the thread knows. */
export interface SavedReplyRecipient {
	firstName?: string | null;
	lastName?: string | null;
	email?: string | null;
}

/** Where a reply goes in the text: the selection, or the `;token` it replaces. */
type TextRange = { start: number; end: number };

export function useTeamComposerSavedReplies(opts: {
	rootEl: Ref<HTMLElement | null>;
	textarea: Ref<HTMLTextAreaElement | null>;
	body: Ref<string>;
	subject: () => string;
	recipient: () => SavedReplyRecipient | null;
	/** The person changed the text (stops a new agent draft from re-seeding it). */
	touch: () => void;
}) {
	const { t, locale } = useI18n();
	const { user } = useAuth();
	const { replies, recordUse } = useComposerSavedReplies(() => null);

	/** A saved reply put `[[...]]` gaps into the text: they hold Send. */
	const gapGuarded = ref(false);

	const context = computed<SnippetVariableContext>(() => {
		const to = opts.recipient();
		const first = to?.firstName?.trim() || null;
		const last = to?.lastName?.trim() || null;
		const me = user.value?.name?.trim() || null;
		return {
			recipientFirstName: first,
			recipientLastName: last,
			recipientFullName: [first, last].filter(Boolean).join(' ') || null,
			recipientEmail: to?.email?.trim() || null,
			senderFirstName: firstNameOf(me) ?? null,
			senderName: me,
			senderEmail: user.value?.email ?? null,
			threadSubject: threadSubjectOf(opts.subject()) || null,
			date: new Date().toLocaleDateString(locale.value),
		};
	});

	// ── Writing a reply into the text ───────────────────────────────────────
	const prompt = ref<SnippetPromptRequest | null>(null);
	let promptRange: TextRange | null = null;

	function write(reply: EditorSnippet, answers: Record<string, string>, range: TextRange) {
		const resolved = resolveSnippetBody(reply.bodyHtml, {
			declared: reply.variables ?? [],
			context: context.value,
			gapLabel: (token, source) =>
				source && source !== 'prompt' ? t(snippetVariableSourceKey(source)) : token,
			answers,
		});
		const text = htmlToPlainText(resolved.html, { preserveBreaks: true }).trim();
		const value = opts.body.value;
		opts.body.value = `${value.slice(0, range.start)}${text}${value.slice(range.end)}`;
		opts.touch();
		recordUse(reply._id);
		if (resolved.hasGaps) gapGuarded.value = true;
		const caret = range.start + text.length;
		void nextTick(() => {
			opts.textarea.value?.focus();
			opts.textarea.value?.setSelectionRange(caret, caret);
		});
	}

	function begin(reply: EditorSnippet, range: TextRange) {
		const fields = promptedSnippetVariables(reply.bodyHtml, reply.variables ?? []);
		if (fields.length === 0) return write(reply, {}, range);
		promptRange = range;
		prompt.value = { snippet: reply, fields };
	}

	function submitPrompt(answers: Record<string, string>) {
		const parked = prompt.value;
		const range = promptRange;
		prompt.value = null;
		promptRange = null;
		if (parked && range) write(parked.snippet, answers, range);
	}

	function cancelPrompt() {
		prompt.value = null;
		promptRange = null;
		opts.textarea.value?.focus();
	}

	/** The picker or the palette chose one: it replaces the selection. */
	function insertAtCaret(reply: EditorSnippet) {
		const el = opts.textarea.value;
		const end = opts.body.value.length;
		begin(reply, el ? { start: el.selectionStart, end: el.selectionEnd } : { start: end, end });
	}

	// ── The `;` trigger in the textarea ─────────────────────────────────────
	const trigger = ref<SnippetTrigger | null>(null);
	const index = ref(0);
	const style = ref<Record<string, string> | null>(null);
	// The token last dismissed with Esc, so it stays closed until it changes.
	let dismissed: string | null = null;
	const items = computed(() =>
		trigger.value ? rankSnippets(replies.value, trigger.value.query) : []
	);

	function closeTrigger() {
		trigger.value = null;
		style.value = null;
	}

	/** After an edit or a caret move: open, refresh or close the dropdown. */
	function refreshTrigger() {
		const el = opts.textarea.value;
		if (!el || el.selectionStart !== el.selectionEnd || replies.value.length === 0) {
			return closeTrigger();
		}
		const found = detectSnippetTrigger(el.value.slice(0, el.selectionStart));
		const token = found ? `${found.triggerStart}:${found.query}` : null;
		if (!found || token === dismissed) {
			if (!found) dismissed = null;
			return closeTrigger();
		}
		dismissed = null;
		if (trigger.value?.triggerStart !== found.triggerStart) index.value = 0;
		trigger.value = found;
		// ";)" is a wink, not a shortcut: only open over something to pick.
		if (items.value.length === 0) return closeTrigger();
		index.value = Math.min(index.value, items.value.length - 1);
		const at = textareaCaretOffset(el, found.triggerStart);
		style.value = at
			? {
					left: `${el.offsetLeft + at.left}px`,
					top: `${el.offsetTop + at.top + at.height + 4}px`,
				}
			: { left: `${el.offsetLeft}px`, top: `${el.offsetTop}px` };
	}

	function selectFromTrigger(reply: EditorSnippet) {
		const found = trigger.value;
		const el = opts.textarea.value;
		closeTrigger();
		if (!found || !el) return insertAtCaret(reply);
		begin(reply, { start: found.triggerStart, end: el.selectionStart });
	}

	const footer = useComposerSavedReplyPicker({
		rootEl: opts.rootEl,
		replies,
		enabled: () => true,
		currentBodyHtml: () => aiTextToHtml(opts.body.value),
		insert: insertAtCaret,
	});

	/** The dropdown owns ↑ ↓ Enter Tab Esc while open; then ⌘;. True when consumed. */
	function handleKeydown(event: KeyboardEvent): boolean {
		const count = items.value.length;
		if (trigger.value && style.value && count > 0) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				index.value = (index.value + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
				return true;
			}
			if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') {
				event.preventDefault();
				const chosen = items.value[index.value];
				if (chosen) selectFromTrigger(chosen);
				return true;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				dismissed = `${trigger.value.triggerStart}:${trigger.value.query}`;
				closeTrigger();
				return true;
			}
		}
		return footer.handleKeydown(event);
	}

	return {
		footer,
		gapGuarded,
		prompt,
		submitPrompt,
		cancelPrompt,
		dropdown: { items, index, style, select: selectFromTrigger, close: closeTrigger },
		refreshTrigger,
		handleKeydown,
	};
}
