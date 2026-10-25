<script setup lang="ts">
/**
 * Sandboxed iframe renderer for arbitrary HTML email bodies.
 *
 * Defense in depth:
 *   1. sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
 *      — NO scripts (allow-scripts is deliberately omitted, so content stays
 *      inert), but same-origin is granted so the host can read contentDocument
 *      to auto-size the frame to its content. Without it the frame runs in an
 *      opaque origin, contentDocument is null, and every HTML body is clipped to
 *      the 200px min-height with an inner scrollbar. The popup flags are what
 *      let a link open at all: every link is target=_blank (5. below), and a
 *      sandbox without allow-popups silently swallows those clicks. Escaping
 *      the sandbox means the opened page is an ordinary tab (or, in the desktop
 *      app, the default browser), not one that inherits these restrictions.
 *   2. Inline meta-CSP that blocks everything except styles + inline images,
 *      admitting remote images only once the user consents
 *   3. Parser-based sanitize-html allowlist (drops <script>/<style>/<base>/
 *      <meta refresh>/etc.; whitelisted CSS properties; blocks javascript: in
 *      every URL attribute). Replaces a regex-based stripper that left several
 *      privacy/exfiltration holes (style-tag CSS exfil, meta refresh, srcset
 *      bypass) under a sandboxed-but-not-script-free iframe.
 *   4. External images (img src/srcset, CSS backgrounds) load on open only when
 *      the reader says so (preference on and the mail not suspicious, or a
 *      trusted sender); otherwise they wait behind a "Show images" button.
 *      Probable tracking pixels stay stripped either way. Inline `cid:` images
 *      are resolved from the message's own parts to `data:` URLs
 *   5. All <a> rewritten to target=_blank rel=noreferrer noopener
 *   6. Link transparency: real-destination-host tooltips, inline markers on
 *      text-vs-href host mismatches, tracking query params stripped
 *
 * Steps 3, 5 and 6, with dark-mode adaptation, run in the shared render worker
 * (utils/postboxRenderPipeline); step 4 needs a DOM and runs here once the
 * worker answers (composables/postbox/usePostboxRenderedBody).
 */

import type { TrackerDetection } from '@owlat/shared/postboxTrackers';
import type { PostboxRenderScheme } from '~/utils/postboxDarkMode';
import { getPostboxRenderCache } from '~/utils/postboxRenderCache';
import { useReadingComfort } from '~/composables/useReadingComfort';
import { postboxBodyPlaceholder } from '~/utils/postboxBodyPlaceholder';
import { usePostboxBodySource } from '~/composables/postbox/usePostboxBodySource';
import { useRegisterReadableBody } from '~/composables/postbox/usePostboxSenderOpen';
import { usePostboxFrameAutosize } from '~/composables/postbox/usePostboxFrameAutosize';
import { usePostboxCidImages } from '~/composables/postbox/usePostboxCidImages';
import { usePostboxImageConsent } from '~/composables/postbox/usePostboxImageConsent';
import { usePostboxQuoteHighlight } from '~/composables/postbox/usePostboxQuoteHighlight';
import { usePostboxFindInFrame } from '~/composables/postbox/usePostboxFindInFrame';
import type { PostboxMessageFind } from '~/composables/postbox/usePostboxThreadFind';
import { usePostboxRenderedBody } from '~/composables/postbox/usePostboxRenderedBody';
import { usePostboxFrameSelection } from '~/composables/postbox/usePostboxFrameSelection';
import { usePostboxReaderQuoteReply } from '~/composables/postbox/usePostboxReaderContext';
import PostboxQuoteReplyPill from './PostboxQuoteReplyPill.vue';
import type { CitedQuote } from '~/utils/postboxQuoteHighlight';
import type { CidAttachment } from '~/utils/postboxCidImages';
import { notePostboxBodyRendered } from '~/composables/postbox/usePostboxPerfMarks';
import {
	postboxSenderKey,
	postboxSenderTrustLabel,
	resolvePostboxImageBanner,
	type PostboxImageBannerState,
} from '~/utils/postboxImageAllowlist';

const props = defineProps<{
	message: {
		_id?: string;
		/** Owning mailbox — namespaces the offline cache so a different account on
		 *  a shared device is never served this message's cached body. */
		mailboxId?: string;
		htmlBodyInline?: string;
		textBodyInline?: string;
		htmlBodyStorageId?: string;
		textBodyStorageId?: string;
		/** The reader's inline body query reported a blob-only body. */
		hasBodyBlob?: boolean;
		/** The reader opened on a list row and its inline body is on the way. */
		bodyPending?: boolean;
		/** From header — keys the per-sender remote-image allowlist. */
		fromAddress?: string;
		/** Parts with a `contentId` back the body's inline `cid:` images. */
		attachments?: readonly CidAttachment[];
	};
	/** Per-message escape hatch: force light rendering even in dark mode. */
	forceLight?: boolean;
	/**
	 * This message's sender is on the mailbox's remote-image allowlist, so the
	 * body renders its images without asking. Passed in rather than queried here
	 * so the component stays mountable without a Convex client — the reader owns
	 * the single per-mailbox subscription.
	 *
	 * It only unblocks IMAGES. Tracking pixels stay stripped for a trusted
	 * sender exactly as they do for an untrusted one.
	 */
	senderImagesAllowed?: boolean;
	/**
	 * Load remote images on open (the `autoLoadImages` preference). Absent means
	 * ask first, so a caller that does not know the message's risk signals keeps
	 * the conservative behaviour.
	 */
	autoLoadImages?: boolean;
	/**
	 * The message looks suspicious (utils/postboxImageAllowlist): images never
	 * load on open, whatever the preference or the allowlist says.
	 */
	suspicious?: boolean;
	/** A cited quote of the thread brief to mark and scroll to. */
	highlightQuote?: CitedQuote | null;
	/** Find in conversation's matches in this body (the reader's find state). */
	find?: PostboxMessageFind | null;
	/** Render the image banner there instead (the calm reader's Details, §3). */
	imageBannerTo?: HTMLElement | null;
}>();

const emit = defineEmits<{
	/** Fires with the current tracker detection so the reader header can badge it. */
	trackers: [detection: TrackerDetection];
	/** "Always for this sender" — the reader persists the grant. */
	trustSender: [fromAddress: string];
	/** Revoke, from the auto-loaded banner. */
	untrustSender: [fromAddress: string];
	/** Whether the cited passage was found in the rendered body. */
	citeLocated: [isLocated: boolean];
	/** The image banner's state, for the calm reader's notice slot and summary. */
	imageState: [kind: PostboxImageBannerState['kind']];
}>();

const { t } = useI18n();

const { isDark } = useAppTheme();
// Text size and reading width (Preferences → Reading comfort): part of the
// rendered document and of its cache key, so a change re-renders the body.
const { mailTypography } = useReadingComfort();

// Offline read cache: persist this message's post-sanitize srcdoc once rendered
// (so it stays readable without a connection) and show the cached srcdoc until
// the live body arrives: as-is offline, with remote loads blocked online (see
// utils/postboxBodyPlaceholder). Best-effort + fail-soft; never stores raw mail,
// only the sanitized document the iframe already shows.
const { isOffline, persistBody, loadBody } = usePostboxOfflineCache(() => props.message.mailboxId);
const cachedSrcdoc = ref<string | null>(null);
let offlineBodyRequestSequence = 0;
watch(
	() => props.message._id,
	async (id) => {
		const requestSequence = ++offlineBodyRequestSequence;
		// Clear synchronously so switching messages never briefly shows the prior
		// message's cached body while the async load resolves.
		cachedSrcdoc.value = null;
		const cachedBody = id ? await loadBody(id) : null;
		if (requestSequence !== offlineBodyRequestSequence) return;
		cachedSrcdoc.value = cachedBody?.srcdoc ?? null;
	},
	{ immediate: true }
);

// Scheme requested by the app: dark unless the app is light or the user
// forced this one message back to light rendering.
const appScheme = computed<PostboxRenderScheme>(() =>
	isDark.value && !props.forceLight ? 'dark' : 'light'
);

// Remote-image consent: the load-on-open policy, "Show once", "Load everything".
const { showImages, loadEverything, loadEverythingNow } = usePostboxImageConsent({
	messageId: () => props.message._id,
	images: () => props,
});
const showQuoted = ref(false);
// Find shows the quote while a match sits in it, apart from the reader's own
// toggle: closing find folds it away again unless the reader opened it. Hiding
// it by hand while find holds it open wins until find lets go.
const quoteHiddenByHand = ref(false);
const findForcesQuote = computed(() => !!props.find?.forceQuoted && !quoteHiddenByHand.value);
watch(
	() => !!props.find?.forceQuoted,
	(forced) => {
		if (!forced) quoteHiddenByHand.value = false;
	}
);
const quotedShown = computed(() => showQuoted.value || findForcesQuote.value);
function toggleQuoted() {
	if (quotedShown.value) {
		showQuoted.value = false;
		if (findForcesQuote.value) quoteHiddenByHand.value = true;
	} else {
		showQuoted.value = true;
	}
}
const iframeRef = ref<HTMLIFrameElement | null>(null);
usePostboxQuoteHighlight({
	frame: iframeRef,
	quote: () => props.highlightQuote,
	onResult: (isLocated) => emit('citeLocated', isLocated),
});
usePostboxFindInFrame({ frame: iframeRef, find: () => props.find });

/** Canonical sender key, or null when the From header holds no address. */
const senderKey = computed(() => postboxSenderKey(props.message.fromAddress));
/** What the "Always for…" button names (the sender's domain). */
const senderTrustLabel = computed(() => postboxSenderTrustLabel(props.message.fromAddress));

// Inline body, a blob download, or still waiting for the reader's inline body
// query (see usePostboxBodySource).
const { waiting, contentFinal, effectiveHtml, effectiveText } = usePostboxBodySource(
	() => props.message
);

// Inline `cid:` images, loaded from the message's own parts. Until they are in,
// the render is not final: it is neither cached nor saved for offline reading.
const { urls: cidImageUrls, pending: cidImagesPending } = usePostboxCidImages(() => ({
	messageId: props.message._id,
	html: effectiveHtml.value,
	attachments: props.message.attachments,
}));
const renderFinal = computed(() => contentFinal.value && !cidImagesPending.value);

// The saved copy shown in place of a live body that is not here (yet).
const placeholder = computed(() =>
	postboxBodyPlaceholder(cachedSrcdoc.value, {
		blockRemote: !isOffline.value,
		typography: mailTypography.value,
	})
);

// The sanitized document, rendered by the shared render worker (string
// pipeline) plus the main-thread image-consent stage, and memoised in the
// session LRU: re-opening a thread is a synchronous cache hit.
const rendered = usePostboxRenderedBody(() => ({
	messageId: props.message._id,
	html: effectiveHtml.value ?? '',
	text: effectiveText.value,
	scheme: appScheme.value,
	showQuoted: quotedShown.value,
	showImages: showImages.value,
	loadEverything: loadEverything.value,
	typography: mailTypography.value,
	cidUrls: cidImageUrls.value,
	final: renderFinal.value,
	blockedImageLabel: t('components.postbox.postboxMessageBody.blockedImage'),
	emptyLabel: t('components.postbox.postboxMessageBody.emptyMessage'),
}));
const render = rendered.entry;
const renderKey = rendered.renderKey;

// Whether the live pipeline actually produced a body (vs an "(empty message)"
// placeholder while a blob body is still unfetched).
const hasLiveContent = computed(() => !!(effectiveHtml.value || effectiveText.value));

// The document the iframe renders: the live render when we have real content
// and it is done, otherwise the saved copy (still loading or rendering,
// offline or degraded), otherwise the live render.
const shownPlaceholder = computed(() =>
	hasLiveContent.value && render.value ? null : placeholder.value
);
const displaySrcdoc = computed(() => shownPlaceholder.value?.srcdoc ?? render.value?.srcdoc ?? '');

// Paragraph-bar skeleton while the body loads or its first render runs, unless
// a saved copy can stand in for it. Degrades to the normal "(empty message)"
// iframe if the action errors or the download fails.
const bodyLoading = computed(() =>
	waiting.value ? !placeholder.value : !shownPlaceholder.value && !render.value
);
// Senders (§5): the live body is the readable one; skeleton and saved copy are not.
const readableEl = ref<HTMLElement | null>(null);
useRegisterReadableBody(() =>
	waiting.value || (hasLiveContent.value && !render.value) ? null : readableEl.value
);

// Persist the rendered srcdoc once the render of the final body is in and
// non-empty. Best-effort (LRU-capped, quota-safe); keeps the 50
// most-recently-read bodies offline.
watch(
	[render, rendered.settled, hasLiveContent],
	() => {
		const entry = render.value;
		if (entry && rendered.settled.value && hasLiveContent.value && props.message._id) {
			void persistBody(props.message._id, entry.srcdoc);
		}
	},
	{ immediate: true }
);
// Scheme the iframe actually renders with ("designed" mail stays light —
// a paper card on the dark app background — even when the app is dark). The
// saved copy carries its own scheme and kind in its head.
const renderScheme = computed(
	() => shownPlaceholder.value?.scheme ?? render.value?.renderScheme ?? 'light'
);
// Plain mail sits straight on the message card (transparent canvas, no frame);
// designed mail keeps its own canvas on a white paper card, and so does the
// "(empty message)" document.
const isPaper = computed(() =>
	shownPlaceholder.value
		? shownPlaceholder.value.kind === 'designed'
		: !hasLiveContent.value || render.value?.kind === 'designed'
);
const trackerDetection = computed<TrackerDetection>(() => rendered.detection.value);

// Only a shown render reports: a body still rendering has no facts yet.
watch(
	render,
	(entry) => {
		if (entry) emit('trackers', entry.detection);
	},
	{ immediate: true }
);

const hasRemoteImages = computed(() => render.value?.hasRemoteImages ?? false);

// Exactly one banner sits above the body; which one is a pure function of the
// render's facts (utils/postboxImageAllowlist), so the choice between the
// banner states is unit-tested without mounting this component.
const imageBanner = computed(() =>
	resolvePostboxImageBanner({
		hasRemoteImages: hasRemoteImages.value,
		showImages: showImages.value,
		loadEverything: loadEverything.value,
		// The grant only says something when the preference would ask; with images
		// loading for everyone, "Always for this sender" has nothing to add.
		isSenderAllowed: !!props.senderImagesAllowed && !props.autoLoadImages && !props.suspicious,
		hasSenderKey: senderKey.value !== null,
		trackerCount: trackerDetection.value.pixelCount,
		inventoryFailed: render.value?.inventoryFailed ?? false,
		isSuspicious: !!props.suspicious,
	})
);

/** Flattened for the template: narrowing a discriminated union across
 *  sibling v-else-if branches is more fragile than reading a plain kind. */
const imageBannerKind = computed(() => imageBanner.value.kind);
watch(
	[imageBannerKind, () => render.value !== null],
	([kind, isRendered]) => {
		if (isRendered) emit('imageState', kind);
	},
	{ immediate: true }
);
const canTrustSender = computed(() => senderKey.value !== null);

const hasQuotedContent = computed(() => render.value?.hasQuote ?? false);

function trustSender() {
	const from = props.message.fromAddress;
	if (!from) return;
	// Show the images immediately — the grant is a save, not a request, and the
	// reader should not wait on a round trip to honour a click it already has.
	showImages.value = true;
	emit('trustSender', from);
}

// "Quote in reply" over a passage selected in the body, where the reader
// offers it for this message and the frame shows its text (not the
// "(empty message)" stand-in).
const quoteReply = usePostboxReaderQuoteReply();
const frameBox = ref<HTMLElement | null>(null);
const quotePill = ref<{ el: HTMLElement | null; focus: () => void } | null>(null);
const frameSelection = usePostboxFrameSelection({
	iframeRef,
	srcdoc: displaySrcdoc,
	enabled: () =>
		!!props.message._id &&
		(hasLiveContent.value || !!shownPlaceholder.value) &&
		!!quoteReply?.canQuote(props.message._id),
	onQuote: quoteSelection,
	actionEl: () => quotePill.value?.el ?? null,
	focusAction: () => quotePill.value?.focus(),
});
const selectedPassage = frameSelection.selection;
function quoteSelection(passage: string) {
	const id = props.message._id;
	frameSelection.clear();
	if (id && quoteReply?.canQuote(id)) quoteReply.quote(id, passage);
}

function untrustSender() {
	const from = props.message.fromAddress;
	if (!from) return;
	emit('untrustSender', from);
}

// Pre-size the iframe from the last measured height for this exact render so
// re-opening a thread doesn't flash the 200px min-height and jump to full size.
// Kept as an explicit ref (rather than reading the non-reactive cache in the
// template) so the height updates when the render key changes. A new render of
// the SAME message with no cached height yet (show images, show quoted text)
// keeps the current height until the new document is measured, instead of
// dropping back to the min-height for a frame or two.
const presetHeight = ref<number | null>(null);
watch(
	[renderKey, () => props.message._id],
	([key, messageId], previous) => {
		const cached = key ? (getPostboxRenderCache().get(key)?.height ?? null) : null;
		const sameMessage = previous !== undefined && previous[1] === messageId;
		presetHeight.value = cached ?? (sameMessage ? presetHeight.value : null);
	},
	{ immediate: true }
);

// Fit the frame to its document from the moment it is parsed, then follow it
// (late images, fonts, pane resizes), and remember the height so the next
// render of this message can pre-size instead of jumping.
usePostboxFrameAutosize({
	iframeRef,
	srcdoc: displaySrcdoc,
	minHeight: () => (isPaper.value ? 120 : 24),
	onHeight: (height) => {
		// A measured document is a body on screen: it ends a timed open (plan
		// 0.2) once it is the real body or its saved copy, not the error stand-in.
		if (contentFinal.value || shownPlaceholder.value) notePostboxBodyRendered(props.message._id);
		presetHeight.value = height;
		const key = rendered.shownKey.value;
		if (key && !shownPlaceholder.value) getPostboxRenderCache().update(key, { height });
	},
});
</script>

<template>
	<div v-if="bodyLoading" class="mt-4">
		<PostboxReaderSkeleton :with-header="false" />
	</div>
	<div v-else ref="readableEl" class="mt-4">
		<Teleport :to="imageBannerTo" :disabled="!imageBannerTo">
			<PostboxImageBanner
				:kind="imageBannerKind"
				:tracker-count="trackerDetection.pixelCount"
				:can-trust-sender="canTrustSender"
				:sender-label="senderTrustLabel"
				@show-once="showImages = true"
				@load-everything="loadEverythingNow()"
				@trust-sender="trustSender()"
				@untrust-sender="untrustSender()"
			/>
		</Teleport>
		<!-- The box the "Quote in reply" pill is placed in, over the frame. -->
		<div ref="frameBox" class="relative">
			<!-- palette-ok: designed mail keeps its own colors on a white paper card
			     (also on the dark app background). Plain mail paints nothing, so it
			     reads as part of the message card; `color-scheme` is pinned to the
			     frame's own scheme because the browser paints an opaque backdrop
			     behind a frame whose scheme differs from its embedder's. -->
			<iframe
				ref="iframeRef"
				:srcdoc="displaySrcdoc"
				sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
				class="block w-full"
				:class="isPaper ? 'rounded-md border border-border-subtle bg-white' : 'bg-transparent'"
				:style="{
					minHeight: isPaper ? '200px' : '48px',
					height: presetHeight ? `${presetHeight}px` : undefined,
					colorScheme: renderScheme,
				}"
				referrerpolicy="no-referrer"
			/>
			<PostboxQuoteReplyPill
				v-if="selectedPassage"
				ref="quotePill"
				:anchor="selectedPassage.anchor"
				:bounds-width="frameBox?.clientWidth ?? 0"
				@quote="quoteSelection(selectedPassage.text)"
				@dismiss="frameSelection.clear()"
			/>
		</div>
		<button
			v-if="hasQuotedContent"
			type="button"
			class="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-surface"
			@click="toggleQuoted"
		>
			<Icon :name="quotedShown ? 'lucide:chevron-up' : 'lucide:chevron-down'" class="w-3.5 h-3.5" />
			{{
				quotedShown
					? t('components.postbox.postboxMessageBody.hideQuoted')
					: t('components.postbox.postboxMessageBody.showQuoted')
			}}
		</button>
	</div>
</template>
