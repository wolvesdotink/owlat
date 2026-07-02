<script setup lang="ts">
/**
 * Postbox basic rich-text editor.
 *
 * `contenteditable` + Selection/Range plumbing shared with the campaign
 * builder via `useRichText` in @owlat/ui. Toolbar covers B / I / U, H1-H2,
 * bullet & ordered lists, blockquote, link. v-models raw HTML.
 *
 * For richer compositions (heroes, columns, tables, …) the composer's
 * "Designer" mode mounts the full @owlat/email-builder instead.
 *
 * The empty document is normalized to `<p><br></p>` so the cursor always
 * lives inside a real paragraph (avoids browser-quirky wrapping on first
 * keystroke).
 */

import {
	useRichText,
	EMPTY_ACTIVE_MARKS,
	type ActiveMarks,
} from '@owlat/ui/composables/useRichText';
import { usePostboxGhostOverlay } from '~/composables/postbox/usePostboxGhostOverlay';
import { usePostboxRewriteController } from '~/composables/postbox/usePostboxRewriteController';
import { usePostboxFloatingFormatBar } from '~/composables/postbox/usePostboxFloatingFormatBar';
import { usePostboxInlineImages } from '~/composables/postbox/usePostboxInlineImages';
import { usePostboxEmojiPicker } from '~/composables/postbox/usePostboxEmojiPicker';
import { usePostboxEditorInput } from '~/composables/postbox/usePostboxEditorInput';
import { matchAsciiSmiley } from '~/utils/postboxEmojiShortcodes';
import {
	detectSnippetTrigger,
	rankSnippets,
	resolveSnippetPlaceholders,
} from '~/utils/postboxSnippets';
import type { Id } from '@owlat/api/dataModel';

/** A canned response offered by the composer's "/" slash-trigger. */
export interface EditorSnippet {
	_id: string;
	name: string;
	shortcut: string;
	bodyHtml: string;
}

const props = defineProps<{
	modelValue: string;
	placeholder?: string;
	/**
	 * Enable inline ghost-text autocomplete (Tab to accept). The parent passes
	 * `ai` flag AND the per-user "Writing suggestions" toggle. Off by default so
	 * the editor's other mount sites (e.g. signatures) never call out.
	 */
	suggestionsEnabled?: boolean;
	/** Bounded thread context for the completion prompt (untrusted data). */
	ghostThreadContext?: string;
	/**
	 * Enable the AI selection-rewrite pill (Shorter / Friendlier / …). Gated on
	 * the `ai` flag ONLY (unlike ghost text, no per-user toggle). Off by default.
	 */
	rewriteEnabled?: boolean;
	/** Mailbox whose voice profile personalizes rewrites (optional). */
	rewriteMailboxId?: Id<'mailboxes'>;
	/**
	 * Show the classic persistent formatting toolbar bolted to the top of the
	 * editor. Default (false) is the Apple-minimal mode: the toolbar is hidden
	 * and a floating format bar appears above a non-empty text selection instead.
	 * Keyboard shortcuts work in both modes.
	 */
	persistentToolbar?: boolean;
	/**
	 * Enable pasting/dropping images INTO the body as inline (cid-embedded)
	 * images. The parent supplies `embedImage` (downscale + upload → contentId +
	 * preview URL); off by default so the signature editor never embeds.
	 */
	inlineImagesEnabled?: boolean;
	/** Upload an image and return the contentId + ephemeral preview URL to insert. */
	embedImage?: (file: File) => Promise<{ contentId: string; previewUrl: string } | null>;
	/** Called with the contentId of an inline image removed from the body. */
	onRemoveEmbeddedImage?: (contentId: string) => void;
	/** Enable the `:shortcode:` emoji picker + ASCII-smiley conversion (opt-in). */
	emojiShortcodesEnabled?: boolean;
	/**
	 * Canned responses offered by the "/" slash-trigger. Empty/undefined
	 * disables the picker entirely (the editor's other mount sites don't wire
	 * snippets, so "/" stays literal there).
	 */
	snippets?: EditorSnippet[];
	/**
	 * First name of the draft's first To recipient, used to resolve
	 * `{{firstName}}` placeholders on insert. Unknown -> visible `[firstName]`.
	 */
	snippetFirstName?: string | null;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: string): void;
}>();

const editorRef = ref<HTMLDivElement | null>(null);
const surfaceRef = ref<HTMLDivElement | null>(null);
const isEmpty = ref(true);
const activeMarks = ref<ActiveMarks>({ ...EMPTY_ACTIVE_MARKS });

const richText = useRichText({
	editorRef,
	onChange: () => emitContent(),
	// Notion-style markdown typing shortcuts are a Postbox-only affordance.
	patternShortcuts: true,
	// ASCII-smiley conversion on space (`:)` -> 🙂) rides the shared one-shot-undo
	// plumbing; only active when the emoji shortcodes affordance is opted in.
	asciiReplace: (before) => {
		if (props.emojiShortcodesEnabled !== true) return null;
		const m = matchAsciiSmiley(before);
		return m ? { spanLen: m.ascii.length, replacement: m.char, literal: m.ascii } : null;
	},
});

const {
	toggleBold,
	toggleItalic,
	toggleUnderline,
	toggleHeading,
	toggleBlockquote,
	toggleList,
	setLink,
	pasteAsPlainText,
	handleFormatKeydown,
	handleBeforeInput,
	handleShortcutUndoKeydown,
	resetShortcutUndo,
	readActiveMarks,
} = richText;

function syncActiveMarks() {
	activeMarks.value = readActiveMarks();
}

function syncEmptyState() {
	const el = editorRef.value;
	if (!el) {
		isEmpty.value = true;
		return;
	}
	const text = el.innerText.replace(/​/g, '').trim();
	isEmpty.value = text.length === 0;
}

function ensureScaffold() {
	const el = editorRef.value;
	if (!el) return;
	if (el.childNodes.length === 0) {
		el.innerHTML = '<p><br></p>';
	}
}

function emitContent() {
	const el = editorRef.value;
	if (!el) return;
	emit('update:modelValue', el.innerHTML);
	syncEmptyState();
	syncActiveMarks();
}

// The editor input path must NEVER await the network: `onInput` only emits and
// arms the debounce timer; the completion resolves (or is dropped) out of band.
function onInput() {
	emitContent();
	updateSnippetPicker();
	// While the snippet picker is open the caret sits in a "/token" run; don't
	// also fire ghost-text requests over it.
	if (!snippetOpen.value) scheduleGhost();
	emoji.refresh(); // re-evaluate the `:shortcode:` trigger at the caret
	// Typing invalidates any pending/previewed rewrite anchored to old text.
	rewriteCtl.invalidateOnEdit();
	// An edit may have removed an inline image — drop its pending part.
	inlineImages.reconcile();
}

// ── Inline ghost-text autocomplete ─────────────────────────────────────
// A muted suggestion at the caret, requested after a typing pause and accepted
// with Tab. The caret sampling + overlay placement live in the composable (so
// this component stays under the file-size ratchet); the overlay is a
// non-editable sibling of the contenteditable — NEVER part of the DOM the draft
// serializes from, so an un-accepted ghost can't leak into the sent message.
const { ghost, ghostStyle, schedule: scheduleGhost } = usePostboxGhostOverlay({
	editorRef,
	surfaceRef,
	enabled: () => props.suggestionsEnabled === true,
	threadContext: () => props.ghostThreadContext ?? '',
	emitContent,
});

// ── Snippet "/" slash-trigger picker ────────────────────────────────────
// Typing "/" at the start of a line (or after whitespace) opens a compact
// canned-response picker. Filter-as-you-type, arrow keys + Enter to insert,
// Esc to dismiss (the literal "/" is never removed until a snippet is chosen,
// so dismissing simply leaves it as typed). Insertion routes through the
// browser edit pipeline so undo + autosave both see it.

const snippetOpen = ref(false);
const snippetQuery = ref('');
const snippetIndex = ref(0);
const snippetStyle = ref<Record<string, string> | null>(null);
// The trigger token last dismissed with Esc — suppresses immediate reopening
// while the caret still sits in the same "/token" run.
const snippetDismissed = ref<string | null>(null);

const snippetItems = computed(() =>
	rankSnippets(props.snippets ?? [], snippetQuery.value)
);

function hasSnippets() {
	return (props.snippets?.length ?? 0) > 0;
}

/** Text from the start of the caret's text node up to the caret, or null. */
function getSnippetCaretText(): string | null {
	const el = editorRef.value;
	const sel = window.getSelection();
	if (!el || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
	const node = sel.focusNode;
	if (!node || !el.contains(node)) return null;
	if (node.nodeType !== Node.TEXT_NODE) return '';
	return (node.textContent ?? '').slice(0, sel.focusOffset);
}

function closeSnippet() {
	snippetOpen.value = false;
	snippetStyle.value = null;
}

function dismissSnippet() {
	const before = getSnippetCaretText();
	const trigger = before == null ? null : detectSnippetTrigger(before);
	snippetDismissed.value = trigger ? `${trigger.triggerStart}:${trigger.query}` : null;
	closeSnippet();
}

/** Re-evaluate the trigger after an edit; open/refresh/close the picker. */
function updateSnippetPicker() {
	if (!hasSnippets()) return closeSnippet();
	const before = getSnippetCaretText();
	const trigger = before == null ? null : detectSnippetTrigger(before);
	if (!trigger) {
		snippetDismissed.value = null;
		return closeSnippet();
	}
	const token = `${trigger.triggerStart}:${trigger.query}`;
	if (snippetDismissed.value === token) return; // stay closed until token changes
	snippetDismissed.value = null;
	snippetQuery.value = trigger.query;
	if (!snippetOpen.value) {
		snippetOpen.value = true;
		snippetIndex.value = 0;
	}
	snippetIndex.value = Math.min(
		snippetIndex.value,
		Math.max(0, snippetItems.value.length - 1)
	);
	void nextTick(() => positionSnippet());
}

/** Position the picker just below the caret; drop it if unmeasurable. */
function positionSnippet() {
	const surface = surfaceRef.value;
	const sel = window.getSelection();
	if (!surface || !sel || sel.rangeCount === 0) return closeSnippet();
	const range = sel.getRangeAt(0).cloneRange();
	range.collapse(false);
	const rects = range.getClientRects();
	const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
	if (!rect || (rect.top === 0 && rect.left === 0 && rect.height === 0)) {
		return closeSnippet();
	}
	const host = surface.getBoundingClientRect();
	snippetStyle.value = {
		left: `${rect.left - host.left + surface.scrollLeft}px`,
		top: `${rect.bottom - host.top + surface.scrollTop + 4}px`,
	};
}

function snippetNext() {
	const max = snippetItems.value.length;
	if (max === 0) return;
	snippetIndex.value = (snippetIndex.value + 1) % max;
}

function snippetPrev() {
	const max = snippetItems.value.length;
	if (max === 0) return;
	snippetIndex.value = (snippetIndex.value - 1 + max) % max;
}

/** Replace the "/token" with the snippet HTML through the edit pipeline. */
function insertSnippet(snippet: EditorSnippet) {
	const el = editorRef.value;
	if (!el) return;
	const before = getSnippetCaretText();
	const trigger = before == null ? null : detectSnippetTrigger(before);
	closeSnippet();
	snippetDismissed.value = null;
	el.focus();
	const tokenLen = trigger ? 1 + trigger.query.length : 0;
	for (let i = 0; i < tokenLen; i++) document.execCommand('delete', false);
	const resolved = resolveSnippetPlaceholders(snippet.bodyHtml, {
		firstName: props.snippetFirstName ?? undefined,
	});
	const ok = document.execCommand('insertHTML', false, resolved);
	if (!ok) {
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0) {
			const range = sel.getRangeAt(0);
			range.deleteContents();
			const frag = range.createContextualFragment(resolved);
			range.insertNode(frag);
			range.collapse(false);
		}
	}
	emitContent();
}

function onSnippetItemClick(snippet: EditorSnippet) {
	insertSnippet(snippet);
}

// ── AI selection rewrite (Shorter / Friendlier / … / Translate) ─────────
// A tiny floating pill over a >=3-word selection offers one-tap rewrites; the
// result is shown as an original-vs-rewritten preview the user must Apply. The
// whole lifecycle (placement, saved range, Apply/Discard/Undo) lives in the
// controller composable; the editor just wires its refs + input hooks to it.

const rewriteCtl = usePostboxRewriteController({
	editorRef,
	surfaceRef,
	richText,
	enabled: () => props.rewriteEnabled === true,
	// The standalone pill only shows in the classic persistent-toolbar mode. In
	// the default floating mode the AI actions render inside the combined format
	// bar (see `showAiActions` below), so the pill stays suppressed.
	pillEnabled: () => props.persistentToolbar === true,
	mailboxId: () => props.rewriteMailboxId,
	emitContent,
});

// Whether the combined floating bar should render the AI rewrite actions: only
// in floating mode, when the rewrite feature is on and the selection is eligible.
const showAiActions = computed(
	() =>
		props.persistentToolbar !== true &&
		props.rewriteEnabled === true &&
		rewriteCtl.eligible.value,
);

// ── Floating format bar (minimal mode) ──────────────────────────────────
// Above a non-empty selection inside the editor; flips below near the top,
// clamped to the surface, hidden on scroll/blur/collapse. Never steals focus
// (the bar container uses `mousedown.prevent`). The placement math + scroll-hide
// live in the composable so this component stays under the file-size ratchet.
const {
	formatBarStyle,
	formatBarRef,
	refresh: refreshFormatBar,
	hide: hideFormatBar,
} = usePostboxFloatingFormatBar({
	editorRef,
	surfaceRef,
	enabled: () => props.persistentToolbar !== true,
});

// ── Inline images (paste / drop into the body) ─────────────────────────────
// Insert-at-caret, reconcile-on-delete, and the paste/drop handling live in the
// composable so this component stays under the file-size ratchet.
const inlineImages = usePostboxInlineImages({
	editorRef,
	enabled: () => props.inlineImagesEnabled === true,
	embedImage: () => props.embedImage,
	onRemoveEmbeddedImage: () => props.onRemoveEmbeddedImage,
	emitContent,
});

// `:shortcode:` emoji picker; logic in composable. The sibling ASCII-smiley
// conversion rides `useRichText`'s `asciiReplace` (shared one-shot-undo), above.
const emoji = usePostboxEmojiPicker({
	editorRef,
	surfaceRef,
	enabled: () => props.emojiShortcodesEnabled === true,
	replaceSelection: richText.replaceSelection,
	emitContent,
});

// One linear keyboard/beforeinput pathway multiplexed across the emoji picker,
// ghost text, the AI rewrite pill, the shared undo, and format shortcuts.
const { onBeforeInput, onKeydown: baseOnKeydown } = usePostboxEditorInput({
	handleBeforeInput,
	handleShortcutUndoKeydown,
	handleFormatKeydown,
	emitContent,
	emoji,
	ghost,
	rewrite: rewriteCtl,
});

// The snippet picker owns navigation keys while it's open; otherwise the key
// event flows to the multiplexed editor-input pathway (emoji / ghost / rewrite
// / format shortcuts).
function onKeydown(event: KeyboardEvent) {
	if (snippetOpen.value) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			snippetNext();
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			snippetPrev();
			return;
		}
		if (event.key === 'Enter' || event.key === 'Tab') {
			const selected = snippetItems.value[snippetIndex.value];
			if (selected) {
				event.preventDefault();
				insertSnippet(selected);
				return;
			}
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			dismissSnippet();
			return;
		}
	}
	baseOnKeydown(event);
}

function onPaste(event: ClipboardEvent) {
	// When the clipboard carries images and inline embedding is on, the composable
	// consumes the event; otherwise fall back to the plain-text paste path.
	if (inlineImages.handlePaste(event)) return;
	pasteAsPlainText(event);
}

function onDrop(event: DragEvent) {
	// Image drops embed inline; non-image drops fall through to the composer's
	// drop-to-attach handler.
	inlineImages.handleDrop(event);
}

function onBlur() {
	emitContent();
	ghost.cancel(); // never leave a ghost hanging over an unfocused editor
	resetShortcutUndo(); // a literal-restore undo (markdown/ASCII) shouldn't survive leaving the editor
	emoji.close(); // never leave the picker popover open over an unfocused editor
	hideFormatBar(); // never leave the floating bar over an unfocused editor
	closeSnippet(); // …nor the snippet picker over an unfocused editor
}

function onSelectionChange() {
	if (richText.getSelection()) syncActiveMarks();
	// A caret move (arrow/click) invalidates a shown ghost. Only dismiss when one
	// is visible, so this can't clear a request still pending in its debounce.
	if (ghost.hasGhost()) ghost.cancel();
	// A caret move re-evaluates an OPEN emoji picker (closes it if the trigger is gone).
	if (emoji.open.value) emoji.refresh();
	// A caret move out of the "/token" run closes the snippet picker; a move within
	// it (e.g. after inserting a char) refreshes the query + position.
	if (snippetOpen.value) {
		const before = getSnippetCaretText();
		const trigger = before == null ? null : detectSnippetTrigger(before);
		if (!trigger) closeSnippet();
		else {
			snippetQuery.value = trigger.query;
			positionSnippet();
		}
	}
	// A selection change aborts an in-flight rewrite (its anchor is now stale)
	// and re-places the pill for the new selection.
	rewriteCtl.onSelectionChange();
	// Re-place (or hide) the floating format bar for the new selection.
	refreshFormatBar();
}

function focusEditor() {
	editorRef.value?.focus();
}

// Toolbar buttons must not steal focus from the editor — `mousedown.prevent`
// in the template handles that. Define guarded handlers that re-focus first.
function withFocus(fn: () => void | Promise<void>) {
	return () => {
		focusEditor();
		void fn();
	};
}

onMounted(() => {
	const el = editorRef.value;
	if (el) {
		if (props.modelValue && el.innerHTML !== props.modelValue) {
			el.innerHTML = props.modelValue;
		} else {
			ensureScaffold();
		}
	}
	syncEmptyState();
	syncActiveMarks();
	document.addEventListener('selectionchange', onSelectionChange);
});

onBeforeUnmount(() => {
	document.removeEventListener('selectionchange', onSelectionChange);
	ghost.cancel();
	emoji.close();
	closeSnippet();
	rewriteCtl.dispose();
});

watch(
	() => props.modelValue,
	(value) => {
		const el = editorRef.value;
		if (!el) return;
		if (el.innerHTML === value) return;
		const isFocused = document.activeElement === el;
		if (isFocused) return; // don't clobber the user's cursor mid-typing
		el.innerHTML = value || '';
		ensureScaffold();
		syncEmptyState();
	}
);

defineExpose({ focus: focusEditor });
</script>

<template>
	<div class="flex flex-col h-full">
		<!-- Classic persistent toolbar: only when the user opts back in via "Aa". -->
		<PostboxEditorToolbar
			v-if="persistentToolbar"
			:active-marks="activeMarks"
			@bold="withFocus(toggleBold)()"
			@italic="withFocus(toggleItalic)()"
			@underline="withFocus(toggleUnderline)()"
			@heading="(level) => withFocus(() => toggleHeading(level))()"
			@list="(ordered) => withFocus(() => toggleList(ordered))()"
			@blockquote="withFocus(toggleBlockquote)()"
			@link="withFocus(setLink)()"
		/>
		<div ref="surfaceRef" class="flex-1 overflow-auto relative">
			<div
				ref="editorRef"
				role="textbox"
				aria-multiline="true"
				contenteditable="true"
				spellcheck="true"
				class="postbox-basic-editor outline-none p-3 min-h-full"
				@beforeinput="onBeforeInput"
				@input="onInput"
				@keydown="onKeydown"
				@paste="onPaste"
				@drop="onDrop"
				@blur="onBlur"
			/>
			<div
				v-if="isEmpty"
				class="absolute top-3 left-3 text-text-tertiary text-sm pointer-events-none select-none"
			>
				{{ placeholder ?? 'Write your message…' }}
			</div>
			<!--
				Ghost text: non-editable, positioned at the caret. Lives OUTSIDE the
				contenteditable so it can never be serialized into the draft; aria-hidden
				because it's advisory chrome, not committed content.
			-->
			<div
				v-if="ghost.ghost.value && ghostStyle"
				class="postbox-ghost-text pointer-events-none absolute whitespace-pre select-none"
				:style="ghostStyle"
				aria-hidden="true"
			>{{ ghost.ghost.value }}</div>
			<PostboxEmojiPicker
				v-if="emojiShortcodesEnabled && emoji.open.value"
				:items="emoji.items.value"
				:active-index="emoji.activeIndex.value"
				:bar-style="emoji.style.value"
				@select="emoji.insert(emoji.items.value[$event])"
				@hover="emoji.setActive($event)"
			/>
			<!--
				Floating format bar (minimal mode): above the current selection. When
				the AI rewrite pill would also show it merges in here as ONE combined
				bar (format left, AI right) instead of a second stacked popover.
			-->
			<PostboxFloatingFormatBar
				v-if="!persistentToolbar"
				ref="formatBarRef"
				:bar-style="formatBarStyle"
				:active-marks="activeMarks"
				:show-ai-actions="showAiActions"
				:ai-loading="rewriteCtl.rewrite.isLoading()"
				:ai-active-intent="rewriteCtl.rewrite.activeIntent.value"
				:ai-languages="rewriteCtl.languages.value"
				@bold="withFocus(toggleBold)()"
				@italic="withFocus(toggleItalic)()"
				@underline="withFocus(toggleUnderline)()"
				@heading="(level) => withFocus(() => toggleHeading(level))()"
				@list="(ordered) => withFocus(() => toggleList(ordered))()"
				@blockquote="withFocus(toggleBlockquote)()"
				@link="withFocus(setLink)()"
				@ai-select="rewriteCtl.onSelect"
			/>
			<!--
				Snippet "/" picker: a compact caret-anchored dropdown. Items use
				mousedown.prevent so clicking one never blurs the editor first.
			-->
			<div
				v-if="snippetOpen && snippetStyle"
				class="postbox-snippet-picker absolute z-20 min-w-[220px] max-w-[320px] rounded-md border border-border-subtle bg-bg-elevated shadow-lg overflow-hidden"
				:style="snippetStyle"
				role="listbox"
				aria-label="Snippets"
			>
				<div
					v-if="snippetItems.length === 0"
					class="px-3 py-2 text-xs text-text-tertiary"
				>
					No matching snippets
				</div>
				<button
					v-for="(item, i) in snippetItems"
					:key="item._id"
					type="button"
					role="option"
					:aria-selected="i === snippetIndex"
					class="w-full text-left px-3 py-1.5 flex items-center justify-between gap-2 text-sm"
					:class="i === snippetIndex ? 'bg-brand-subtle text-text-primary' : 'text-text-secondary hover:bg-bg-surface'"
					@mousedown.prevent="onSnippetItemClick(item)"
					@mousemove="snippetIndex = i"
				>
					<span class="truncate">{{ item.name }}</span>
					<span
						v-if="item.shortcut"
						class="shrink-0 text-xs text-text-tertiary font-mono"
					>/{{ item.shortcut }}</span>
				</button>
			</div>
			<!-- AI rewrite pill + preview + undo affordance (all flag-gated). -->
			<PostboxRewriteLayer
				v-if="rewriteEnabled"
				:controller="rewriteCtl"
			/>
		</div>
	</div>
</template>

<style scoped>
.postbox-basic-editor {
	font-size: 14px;
	line-height: 1.55;
	color: var(--color-text-primary, #1a1a1a);
}
.postbox-basic-editor :deep(h1) {
	font-size: 1.5rem;
	font-weight: 600;
	margin: 0.5em 0 0.3em;
}
.postbox-basic-editor :deep(h2) {
	font-size: 1.25rem;
	font-weight: 600;
	margin: 0.5em 0 0.3em;
}
.postbox-basic-editor :deep(p) {
	margin: 0 0 0.6em;
}
.postbox-basic-editor :deep(ul) {
	list-style: disc;
	padding-left: 1.5em;
	margin: 0 0 0.6em;
}
.postbox-basic-editor :deep(ol) {
	list-style: decimal;
	padding-left: 1.5em;
	margin: 0 0 0.6em;
}
.postbox-basic-editor :deep(blockquote) {
	border-left: 3px solid var(--color-border-subtle, #ddd);
	padding-left: 0.75em;
	color: var(--color-text-secondary, #555);
	margin: 0 0 0.6em;
}
.postbox-basic-editor :deep(a) {
	color: var(--color-brand, #0a6cdd);
	text-decoration: underline;
}
.postbox-basic-editor :deep(img) {
	max-width: 100%;
	height: auto;
	border-radius: 4px;
	margin: 0.25em 0;
}
.postbox-basic-editor :deep(code) {
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 0.9em;
	background: var(--color-bg-subtle, #f2f2f2);
	border: 1px solid var(--color-border-subtle, #e0e0e0);
	border-radius: 3px;
	padding: 0.1em 0.3em;
}
.postbox-ghost-text {
	font-size: 14px;
	line-height: 1.55;
	color: var(--color-text-tertiary, #9aa0a6);
	opacity: 0.75;
}
</style>
