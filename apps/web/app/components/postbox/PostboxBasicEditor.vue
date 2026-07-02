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

import { api } from '@owlat/api';
import {
	useRichText,
	EMPTY_ACTIVE_MARKS,
	type ActiveMarks,
} from '@owlat/ui/composables/useRichText';
import {
	usePostboxGhostText,
	type GhostTextRequestInput,
} from '~/composables/postbox/usePostboxGhostText';
import {
	usePostboxSelectionRewrite,
	isRewriteEligible,
	type RewriteIntent,
	type SelectionRewriteInput,
} from '~/composables/postbox/usePostboxSelectionRewrite';
import { useRewriteLanguages } from '~/composables/postbox/useRewriteLanguages';
import type { Id } from '@owlat/api/dataModel';

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
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: string): void;
}>();

const editorRef = ref<HTMLDivElement | null>(null);
const surfaceRef = ref<HTMLDivElement | null>(null);
const isEmpty = ref(true);
const activeMarks = ref<ActiveMarks>({ ...EMPTY_ACTIVE_MARKS });
const ghostStyle = ref<Record<string, string> | null>(null);

const richText = useRichText({
	editorRef,
	onChange: () => emitContent(),
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
	readActiveMarks,
	replaceSelection,
} = richText;

const { showToast } = useToast();

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
	scheduleGhost();
	// Typing invalidates any pending/previewed rewrite anchored to old text.
	if (rewrite.status.value !== 'idle') rewrite.reset();
	rewritePillStyle.value = null;
	rewritePreviewStyle.value = null;
}

// ── Inline ghost-text autocomplete ─────────────────────────────────────
// A muted suggestion at the caret, requested after a typing pause and accepted
// with Tab. The overlay is a positioned, non-editable sibling of the
// contenteditable — it is NEVER part of the DOM the draft serializes from, so
// an un-accepted ghost can't leak into the sent message. Positioning is
// best-effort: if the caret rect can't be measured, the ghost is dropped rather
// than risk breaking typing.

function insertAcceptedText(text: string) {
	const el = editorRef.value;
	if (!el) return;
	el.focus();
	// execCommand routes through the browser's own edit pipeline, so native
	// undo and the @input autosave both see the insertion as real user text.
	const ok = document.execCommand('insertText', false, text);
	if (!ok) {
		// Fallback: insert a text node at the caret and emit like a real input.
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0) {
			const range = sel.getRangeAt(0);
			range.deleteContents();
			const node = document.createTextNode(text);
			range.insertNode(node);
			range.setStartAfter(node);
			range.collapse(true);
			sel.removeAllRanges();
			sel.addRange(range);
		}
		emitContent();
	}
}

const ghost = usePostboxGhostText({
	enabled: () => props.suggestionsEnabled === true,
	requestCompletion: async (input: GhostTextRequestInput) => {
		const res = await requireConvex().action(api.mail.ai.completeDraft, {
			threadContext: input.threadContext,
			draftSoFar: input.draftSoFar,
			cursorSentence: input.cursorSentence,
		});
		return res?.completion ?? '';
	},
	onAccept: insertAcceptedText,
});

/** Sample the caret context — null unless the caret sits at the end of a text node. */
function getCaretContext(): GhostTextRequestInput | null {
	const el = editorRef.value;
	if (!el) return null;
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
	const focusNode = sel.focusNode;
	if (!focusNode || focusNode.nodeType !== Node.TEXT_NODE) return null;
	if (!el.contains(focusNode)) return null;
	if (sel.focusOffset !== (focusNode.textContent?.length ?? 0)) return null;
	const pre = document.createRange();
	pre.setStart(el, 0);
	pre.setEnd(focusNode, sel.focusOffset);
	const before = pre.toString();
	if (!before.trim()) return null;
	const lastBreak = Math.max(
		before.lastIndexOf('. '),
		before.lastIndexOf('! '),
		before.lastIndexOf('? '),
		before.lastIndexOf('\n')
	);
	const cursorSentence = (lastBreak >= 0 ? before.slice(lastBreak + 1) : before)
		.slice(-500)
		.trimStart();
	return {
		threadContext: (props.ghostThreadContext ?? '').slice(0, 4000),
		draftSoFar: el.innerText.slice(-4000),
		cursorSentence,
	};
}

/** Position the ghost overlay at the caret; drop it if the rect is unmeasurable. */
function positionGhost() {
	const surface = surfaceRef.value;
	const sel = window.getSelection();
	if (!surface || !sel || sel.rangeCount === 0) {
		ghost.cancel();
		return;
	}
	const range = sel.getRangeAt(0).cloneRange();
	range.collapse(false);
	const rects = range.getClientRects();
	const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
	if (!rect || (rect.top === 0 && rect.left === 0 && rect.height === 0)) {
		ghost.cancel(); // fail-soft: hide rather than mis-place
		return;
	}
	const host = surface.getBoundingClientRect();
	ghostStyle.value = {
		left: `${rect.right - host.left + surface.scrollLeft}px`,
		top: `${rect.top - host.top + surface.scrollTop}px`,
		height: `${rect.height}px`,
	};
}

function scheduleGhost() {
	if (props.suggestionsEnabled !== true) return;
	ghost.schedule(() => getCaretContext());
}

watch(ghost.ghost, (value) => {
	if (!value) {
		ghostStyle.value = null;
		return;
	}
	void nextTick(() => positionGhost());
});

// ── AI selection rewrite (Shorter / Friendlier / … / Translate) ─────────
// A tiny floating pill over a >=3-word selection offers one-tap rewrites; the
// result is shown as an original-vs-rewritten preview the user must Apply.
// Apply routes through the editor's own input path (undo-able as one step).

const rewritePillStyle = ref<Record<string, string> | null>(null);
const rewritePreviewStyle = ref<Record<string, string> | null>(null);
// The selection to rewrite, saved so Apply can restore it even if focus moved.
let savedRewriteRange: Range | null = null;
const showRewriteUndo = ref(false);
let undoTimer: ReturnType<typeof setTimeout> | null = null;

const { languages: rewriteLanguages, remember: rememberLanguage } =
	useRewriteLanguages();

const rewrite = usePostboxSelectionRewrite({
	requestRewrite: async (input: SelectionRewriteInput) => {
		const res = await requireConvex().action(api.mail.ai.rewriteSelection, {
			selection: input.selection,
			intent: input.intent,
			...(input.targetLanguage ? { targetLanguage: input.targetLanguage } : {}),
			surroundingContext: input.surroundingContext,
			...(props.rewriteMailboxId ? { mailboxId: props.rewriteMailboxId } : {}),
		});
		return res?.rewritten ?? '';
	},
	onError: (message) => {
		showToast(message, 'error');
	},
});

/** Position a box anchored to the current selection, relative to the surface. */
function selectionBoxStyle(place: 'above' | 'below'): Record<string, string> | null {
	const surface = surfaceRef.value;
	const sel = window.getSelection();
	if (!surface || !sel || sel.rangeCount === 0) return null;
	const rect = sel.getRangeAt(0).getBoundingClientRect();
	if (!rect || (rect.top === 0 && rect.left === 0 && rect.width === 0)) return null;
	const host = surface.getBoundingClientRect();
	const left = rect.left - host.left + surface.scrollLeft;
	if (place === 'above') {
		return {
			left: `${Math.max(left, 4)}px`,
			top: `${rect.top - host.top + surface.scrollTop}px`,
			transform: 'translateY(-100%)',
		};
	}
	return {
		left: `${Math.max(left, 4)}px`,
		top: `${rect.bottom - host.top + surface.scrollTop + 6}px`,
	};
}

/** Recompute pill/preview placement + visibility for the current selection. */
function refreshRewriteUi() {
	if (props.rewriteEnabled !== true) {
		rewritePillStyle.value = null;
		rewritePreviewStyle.value = null;
		return;
	}
	// A live preview owns the anchor; leave it in place until Apply/Discard.
	if (rewrite.hasPreview()) {
		rewritePillStyle.value = null;
		return;
	}
	const ctx = richText.getSelection();
	const text = ctx ? ctx.sel.toString() : '';
	if (ctx && !ctx.range.collapsed && isRewriteEligible(true, text)) {
		savedRewriteRange = ctx.range.cloneRange();
		rewritePillStyle.value = selectionBoxStyle('above');
	} else if (!rewrite.isLoading()) {
		// Keep the pill (with its spinner) while a request is in flight even if the
		// selection collapses; otherwise hide it.
		rewritePillStyle.value = null;
	}
}

function onRewriteSelect(payload: { intent: RewriteIntent; targetLanguage?: string }) {
	const el = editorRef.value;
	if (!el || !savedRewriteRange) return;
	const selection = savedRewriteRange.toString();
	if (!isRewriteEligible(true, selection)) return;
	if (payload.targetLanguage) rememberLanguage(payload.targetLanguage);
	void rewrite.start({
		selection,
		intent: payload.intent,
		...(payload.targetLanguage ? { targetLanguage: payload.targetLanguage } : {}),
		surroundingContext: el.innerText.slice(0, 2000),
	});
}

function restoreRewriteSelection() {
	const range = savedRewriteRange;
	if (!range) return false;
	const sel = window.getSelection();
	if (!sel) return false;
	editorRef.value?.focus();
	sel.removeAllRanges();
	sel.addRange(range);
	return true;
}

function applyRewrite() {
	const text = rewrite.takeApplied();
	if (text === null) return;
	if (!restoreRewriteSelection()) return;
	if (replaceSelection(text)) {
		emitContent();
		// Transient "Rewritten — Undo" affordance reusing the native undo stack.
		showRewriteUndo.value = true;
		if (undoTimer) clearTimeout(undoTimer);
		undoTimer = setTimeout(() => {
			showRewriteUndo.value = false;
		}, 6000);
	}
	rewritePreviewStyle.value = null;
	savedRewriteRange = null;
}

function discardRewrite() {
	rewrite.reset();
	rewritePreviewStyle.value = null;
}

function undoRewrite() {
	showRewriteUndo.value = false;
	if (undoTimer) clearTimeout(undoTimer);
	editorRef.value?.focus();
	document.execCommand('undo');
	emitContent();
}

// Move the preview into view when a rewrite result arrives; drop the pill.
watch(rewrite.status, (status) => {
	if (status === 'preview') {
		rewritePillStyle.value = null;
		void nextTick(() => {
			rewritePreviewStyle.value = selectionBoxStyle('below');
		});
	} else if (status === 'idle') {
		rewritePreviewStyle.value = null;
	}
});

function onKeydown(event: KeyboardEvent) {
	if (ghost.hasGhost()) {
		if (event.key === 'Tab') {
			event.preventDefault();
			ghost.accept();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			ghost.cancel();
			return;
		}
		// Any other key: the draft is changing under the ghost — dismiss it.
		ghost.cancel();
	}
	// Escape dismisses a rewrite pill/preview without touching the selection.
	if (event.key === 'Escape' && rewrite.status.value !== 'idle') {
		event.preventDefault();
		discardRewrite();
		return;
	}
	handleFormatKeydown(event);
}

function onPaste(event: ClipboardEvent) {
	pasteAsPlainText(event);
}

function onBlur() {
	emitContent();
	ghost.cancel(); // never leave a ghost hanging over an unfocused editor
}

function onSelectionChange() {
	if (richText.getSelection()) syncActiveMarks();
	// A caret move (arrow/click) invalidates a shown ghost. Only dismiss when one
	// is visible, so this can't clear a request still pending in its debounce.
	if (ghost.hasGhost()) ghost.cancel();
	// A selection change aborts an in-flight rewrite (its anchor is now stale).
	if (rewrite.isLoading()) rewrite.reset();
	refreshRewriteUi();
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
	rewrite.reset();
	if (undoTimer) clearTimeout(undoTimer);
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
		<div
			class="flex items-center gap-0.5 px-1 py-1 border-b border-border-subtle bg-bg-surface"
		>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.bold }"
				title="Bold (⌘B)"
				@mousedown.prevent
				@click="withFocus(toggleBold)()"
			>
				<Icon name="lucide:bold" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.italic }"
				title="Italic (⌘I)"
				@mousedown.prevent
				@click="withFocus(toggleItalic)()"
			>
				<Icon name="lucide:italic" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.underline }"
				title="Underline (⌘U)"
				@mousedown.prevent
				@click="withFocus(toggleUnderline)()"
			>
				<Icon name="lucide:underline" class="w-4 h-4" />
			</button>
			<span class="w-px h-4 bg-border-subtle mx-1" />
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.h1 }"
				title="Heading 1"
				@mousedown.prevent
				@click="withFocus(() => toggleHeading(1))()"
			>
				<Icon name="lucide:heading-1" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.h2 }"
				title="Heading 2"
				@mousedown.prevent
				@click="withFocus(() => toggleHeading(2))()"
			>
				<Icon name="lucide:heading-2" class="w-4 h-4" />
			</button>
			<span class="w-px h-4 bg-border-subtle mx-1" />
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.ul }"
				title="Bullet list"
				@mousedown.prevent
				@click="withFocus(() => toggleList(false))()"
			>
				<Icon name="lucide:list" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.ol }"
				title="Ordered list"
				@mousedown.prevent
				@click="withFocus(() => toggleList(true))()"
			>
				<Icon name="lucide:list-ordered" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.quote }"
				title="Blockquote"
				@mousedown.prevent
				@click="withFocus(toggleBlockquote)()"
			>
				<Icon name="lucide:quote" class="w-4 h-4" />
			</button>
			<span class="w-px h-4 bg-border-subtle mx-1" />
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.link }"
				title="Link (⌘K)"
				@mousedown.prevent
				@click="withFocus(setLink)()"
			>
				<Icon name="lucide:link" class="w-4 h-4" />
			</button>
		</div>
		<div ref="surfaceRef" class="flex-1 overflow-auto relative">
			<div
				ref="editorRef"
				role="textbox"
				aria-multiline="true"
				contenteditable="true"
				spellcheck="true"
				class="postbox-basic-editor outline-none p-3 min-h-full"
				@input="onInput"
				@keydown="onKeydown"
				@paste="onPaste"
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
			<!-- AI rewrite pill over the selection (flag-gated; hidden while previewing). -->
			<PostboxRewritePill
				v-if="rewriteEnabled && rewritePillStyle"
				:pill-style="rewritePillStyle"
				:loading="rewrite.isLoading()"
				:active-intent="rewrite.activeIntent.value"
				:languages="rewriteLanguages"
				@select="onRewriteSelect"
			/>
			<!-- Original-vs-rewritten preview; Apply/Discard only, never auto-applied. -->
			<PostboxRewritePreview
				v-if="rewriteEnabled && rewritePreviewStyle"
				:card-style="rewritePreviewStyle"
				:original="rewrite.original.value"
				:rewritten="rewrite.rewritten.value"
				@apply="applyRewrite"
				@discard="discardRewrite"
			/>
			<!-- Transient "Rewritten — Undo" affordance (native single-step undo). -->
			<div
				v-if="showRewriteUndo"
				class="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border-subtle bg-bg-elevated px-3 py-1.5 text-xs shadow-lg"
			>
				<span class="text-text-secondary">Rewritten</span>
				<button
					type="button"
					class="font-medium text-brand hover:underline"
					@mousedown.prevent
					@click="undoRewrite"
				>
					Undo
				</button>
			</div>
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
.postbox-ghost-text {
	font-size: 14px;
	line-height: 1.55;
	color: var(--color-text-tertiary, #9aa0a6);
	opacity: 0.75;
}
</style>
