<script setup lang="ts">
/**
 * Sandboxed iframe renderer for arbitrary HTML email bodies.
 *
 * Defense in depth:
 *   1. sandbox="" — no scripts, no same-origin
 *   2. Inline meta-CSP that blocks everything except styles + (gated) images
 *   3. Parser-based sanitize-html allowlist (drops <script>/<style>/<base>/
 *      <meta refresh>/etc.; whitelisted CSS properties; blocks javascript: in
 *      every URL attribute). Replaces a regex-based stripper that left several
 *      privacy/exfiltration holes (style-tag CSS exfil, meta refresh, srcset
 *      bypass) under a sandboxed-but-not-script-free iframe.
 *   4. External images are gated behind a "Show images" button
 *   5. All <a> rewritten to target=_blank rel=noreferrer noopener
 *   6. Link transparency: real-destination-host tooltips, inline markers on
 *      text-vs-href host mismatches, tracking query params stripped
 */

import sanitizeHtml from 'sanitize-html';
import { POSTBOX_SANITIZE_CONFIG } from '@owlat/shared/postboxSanitize';
import {
	detectTrackers,
	stripTrackerPixels,
	trackerPixelLabel,
	type TrackerDetection,
} from '@owlat/shared/postboxTrackers';
import { applyLinkTransparency } from '@owlat/shared/postboxLinkTransparency';
import {
	adaptEmailHtml,
	buildBaseStyle,
	POSTBOX_DARK_PALETTE,
	type PostboxRenderScheme,
} from '~/utils/postboxDarkMode';
import {
	getPostboxRenderCache,
	postboxRenderKey,
	type PostboxRenderEntry,
} from '~/utils/postboxRenderCache';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	message: {
		_id?: string;
		htmlBodyInline?: string;
		textBodyInline?: string;
		htmlBodyStorageId?: string;
		textBodyStorageId?: string;
	};
	/** Per-message escape hatch: force light rendering even in dark mode. */
	forceLight?: boolean;
}>();

const emit = defineEmits<{
	/** Fires with the current tracker detection so the reader header can badge it. */
	trackers: [detection: TrackerDetection];
}>();

const { isDark } = useAppTheme();

// Offline read cache: persist this message's post-sanitize srcdoc once rendered
// (so it stays readable without a connection) and, when offline, serve the
// cached srcdoc if the live body can't be fetched. Best-effort + fail-soft;
// never stores raw mail — only the sanitized document the iframe already shows.
const { isOffline, persistBody, loadBody } = usePostboxOfflineCache();
const cachedSrcdoc = ref<string | null>(null);
watch(
	() => props.message._id,
	async (id) => {
		cachedSrcdoc.value = id ? (await loadBody(id))?.srcdoc ?? null : null;
	},
	{ immediate: true }
);

// Scheme requested by the app: dark unless the app is light or the user
// forced this one message back to light rendering.
const appScheme = computed<PostboxRenderScheme>(() =>
	isDark.value && !props.forceLight ? 'dark' : 'light'
);

const showImages = ref(false);
// Escalation past "Show images": also load probable tracking pixels, which
// otherwise stay stripped even after images are shown.
const loadEverything = ref(false);
const showQuoted = ref(false);
const iframeRef = ref<HTMLIFrameElement | null>(null);

// Bodies over the inline threshold are stored as blobs, not on the row. When
// no inline body is present but a storage id is, fetch the body lazily so
// large mail (newsletters, long threads) no longer renders blank.
const fetchedHtml = ref<string | null>(null);
const fetchedText = ref<string | null>(null);

const needsBodyFetch = computed(
	() =>
		!props.message.htmlBodyInline &&
		!props.message.textBodyInline &&
		!!(props.message.htmlBodyStorageId || props.message.textBodyStorageId)
);

const { data: bodyData, error: bodyError } = useConvexQuery(
	api.mail.mailbox.getMessageBody,
	() =>
		needsBodyFetch.value && props.message._id
			? { messageId: props.message._id as Id<'mailMessages'> }
			: 'skip'
);

// Flips once the lazy body fetch has resolved (with content, empty, or a
// failed blob download) so the loading skeleton can't outlive the fetch.
const bodyFetchSettled = ref(false);

watch(
	() => bodyData.value,
	async (data) => {
		if (data === undefined) return;
		if (data === null) {
			// Message deleted/unreadable — the query resolved empty, so settle
			// and let the reader degrade to the "(empty message)" iframe.
			bodyFetchSettled.value = true;
			return;
		}
		const d = data as {
			htmlInline: string | null;
			textInline: string | null;
			htmlUrl: string | null;
			textUrl: string | null;
		};
		try {
			if (d.htmlInline) fetchedHtml.value = d.htmlInline;
			else if (d.textInline) fetchedText.value = d.textInline;
			else if (d.htmlUrl) fetchedHtml.value = await (await fetch(d.htmlUrl)).text();
			else if (d.textUrl) fetchedText.value = await (await fetch(d.textUrl)).text();
		} catch {
			// Leave empty — the reader shows "(empty message)".
		} finally {
			bodyFetchSettled.value = true;
		}
	},
	{ immediate: true }
);

// Paragraph-bar skeleton while a blob-stored body loads. Degrades to the
// normal "(empty message)" iframe if the query errors or the download fails.
const bodyLoading = computed(
	() =>
		needsBodyFetch.value &&
		!bodyFetchSettled.value &&
		!bodyError.value &&
		// Offline with a cached copy: skip the never-resolving skeleton and show
		// the cached body instead.
		!(isOffline.value && !!cachedSrcdoc.value)
);

const effectiveHtml = computed(() => props.message.htmlBodyInline ?? fetchedHtml.value ?? undefined);
const effectiveText = computed(() => props.message.textBodyInline ?? fetchedText.value ?? '');

function sanitize(html: string): string {
	return sanitizeHtml(html, POSTBOX_SANITIZE_CONFIG);
}

function gateImages(html: string, allow: boolean): string {
	if (allow) return html;
	return html.replace(
		/<img\s+([^>]*)>/gi,
		(match, attrs: string) => {
			const srcMatch = attrs.match(/src=(["'])(?<url>[^"']+)\1/);
			const url = srcMatch?.groups?.['url'];
			if (!url || url.startsWith('data:') || url.startsWith('cid:')) return match;
			return `<span data-blocked-img="${url}" style="display:inline-block;padding:4px 8px;background:#eee;color:#666;font-size:11px;border-radius:3px;">[image]</span>`;
		}
	);
}

function rewriteLinks(html: string): string {
	return html.replace(/<a\s+([^>]*)>/gi, (_match, attrs: string) => {
		// Strip target/rel attrs and rewrite uniformly
		const cleaned = attrs
			.replace(/\s+target\s*=\s*"[^"]*"/gi, '')
			.replace(/\s+rel\s*=\s*"[^"]*"/gi, '');
		return `<a ${cleaned} target="_blank" rel="noreferrer noopener">`;
	});
}

const META_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:;">`;

const quotedSplit = computed(() => {
	const html = effectiveHtml.value;
	if (html) return splitQuotedHtml(html);
	const text = effectiveText.value;
	const split = splitQuotedText(text);
	// Convert to HTML-shape so the rest of the pipeline matches
	const escape = (s: string) =>
		s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
	return {
		fresh: `<pre style="white-space:pre-wrap;font-family:inherit;margin:0;">${escape(split.fresh)}</pre>`,
		quoted: split.quoted
			? `<pre style="white-space:pre-wrap;font-family:inherit;margin:0;color:#666;">${escape(split.quoted)}</pre>`
			: '',
		hasQuote: split.hasQuote,
	};
});

// Run the full render pipeline for the current message + options. Kept as a
// plain function (not a chain of computeds) so a cache hit can skip ALL of it —
// sanitize-html, dark-mode adaptation, tracker detection, image gating and link
// transparency — rather than only skipping the final string concat.
function buildRender(): Omit<PostboxRenderEntry, 'height'> {
	const split = quotedSplit.value;
	const fresh = sanitize(split.fresh);
	const quoted = showQuoted.value ? sanitize(split.quoted) : '';
	const combined = quoted
		? `${fresh}<hr style="margin:1em 0;border:0;border-top:1px solid #eee">${quoted}`
		: fresh;
	// Adaptive dark rendering runs AFTER sanitization on the sanitized string
	// only; when the app is light (or forced light) it's a pass-through no-op.
	const adapted = adaptEmailHtml(combined, appScheme.value);
	// Tracking-pixel detection on the SANITIZED output only (never raw mail).
	const detection = detectTrackers(adapted.html);
	let html = adapted.html;
	// "Show images" loads real content but keeps probable tracking pixels
	// stripped; "Load everything" is the explicit escalation past that.
	if (showImages.value && !loadEverything.value && detection.pixelCount > 0) {
		html = stripTrackerPixels(html);
	}
	const gated = gateImages(html, showImages.value);
	// Link transparency (real-host tooltips, phish-mismatch markers, tracking
	// param stripping) runs on sanitized output only and fails soft to a no-op.
	const linked = rewriteLinks(applyLinkTransparency(gated));
	const srcdoc = `<!doctype html><html><head>${META_CSP}${buildBaseStyle(adapted.scheme, adapted.kind)}</head><body>${linked || '(empty message)'}</body></html>`;
	return { srcdoc, renderScheme: adapted.scheme, detection };
}

// The render key includes every option that changes the output; a body is
// immutable once fetched, so a hit is always valid. We only touch the cache
// once the body content is final (not mid-fetch), so a transient loading state
// can never be memoised under a real key.
const contentFinal = computed(() => !needsBodyFetch.value || bodyFetchSettled.value);
const renderKey = computed(() =>
	props.message._id
		? postboxRenderKey(props.message._id, {
				scheme: appScheme.value,
				showImages: showImages.value,
				loadEverything: loadEverything.value,
				showQuoted: showQuoted.value,
			})
		: null
);

// Session-scoped LRU: re-opening a thread skips the whole pipeline above.
const render = computed<Omit<PostboxRenderEntry, 'height'>>(() => {
	const key = renderKey.value;
	const cache = getPostboxRenderCache();
	if (key && contentFinal.value) {
		const hit = cache.get(key);
		if (hit) return hit;
		const built = buildRender();
		cache.set(key, { ...built, height: null });
		return built;
	}
	return buildRender();
});

const srcdoc = computed(() => render.value.srcdoc);

// Whether the live pipeline actually produced a body (vs an "(empty message)"
// placeholder while a blob body is still unfetched).
const hasLiveContent = computed(() => !!(effectiveHtml.value || effectiveText.value));

// The document the iframe renders: the live render when we have real content,
// otherwise the cached srcdoc (offline/degraded), otherwise the live render.
const displaySrcdoc = computed(() =>
	hasLiveContent.value ? srcdoc.value : cachedSrcdoc.value ?? srcdoc.value
);

// Persist the rendered srcdoc once the body is final and non-empty. Best-effort
// (LRU-capped, quota-safe); keeps the 50 most-recently-read bodies offline.
watch(
	[srcdoc, contentFinal, hasLiveContent],
	() => {
		if (contentFinal.value && hasLiveContent.value && props.message._id) {
			void persistBody(props.message._id, srcdoc.value);
		}
	},
	{ immediate: true }
);
// Scheme the iframe actually renders with ("designed" mail stays light —
// a paper card on the dark app background — even when the app is dark).
const renderScheme = computed(() => render.value.renderScheme);
const trackerDetection = computed<TrackerDetection>(() => render.value.detection);
const hasTrackers = computed(() => trackerDetection.value.pixelCount > 0);

watch(
	trackerDetection,
	(detection) => emit('trackers', detection),
	{ immediate: true }
);

const hasBlockedImages = computed(
	() => !showImages.value && /<img\s/i.test(effectiveHtml.value ?? '')
);
const hasQuotedContent = computed(() => quotedSplit.value.hasQuote);

// Pre-size the iframe from the last measured height for this exact render so
// re-opening a thread doesn't flash the 200px min-height and jump to full size.
// Reconciled against the real content height on load. Kept as an explicit ref
// (rather than reading the non-reactive cache in the template) so the height
// updates when the render key changes.
const presetHeight = ref<number | null>(null);
watch(
	renderKey,
	(key) => {
		presetHeight.value = key ? getPostboxRenderCache().get(key)?.height ?? null : null;
	},
	{ immediate: true }
);

// Auto-resize iframe to content height, and remember it so the next render of
// this message can pre-size instead of jumping.
function resizeIframe() {
	const iframe = iframeRef.value;
	if (!iframe?.contentDocument) return;
	const h = Math.max(120, iframe.contentDocument.documentElement.scrollHeight);
	iframe.style.height = `${h}px`;
	presetHeight.value = h;
	const key = renderKey.value;
	if (key) getPostboxRenderCache().update(key, { height: h });
}

// The iframe mounts late when the body-loading skeleton renders first, so
// attach the resize listener whenever the template ref binds (not onMounted).
watch(iframeRef, (iframe) => {
	iframe?.addEventListener('load', resizeIframe);
});

// Re-fit when the user toggles "Show quoted text" or shows images.
watch([showQuoted, showImages, loadEverything], () => {
	nextTick(resizeIframe);
});
</script>

<template>
	<div v-if="bodyLoading" class="mt-4">
		<PostboxReaderSkeleton :with-header="false" />
	</div>
	<div v-else class="mt-4">
		<div
			v-if="hasBlockedImages"
			class="mb-2 px-3 py-2 rounded bg-bg-surface text-xs flex items-center justify-between"
		>
			<span class="text-text-secondary">
				<template v-if="hasTrackers">
					Images blocked —
					{{ trackerPixelLabel(trackerDetection.pixelCount) }} detected.
				</template>
				<template v-else>
					Images blocked to protect your privacy.
				</template>
			</span>
			<button
				type="button"
				class="text-brand font-medium hover:underline"
				@click="showImages = true"
			>
				Show images
			</button>
		</div>
		<!-- After "Show images", probable tracking pixels stay stripped until
		     the user explicitly escalates to loading everything. -->
		<div
			v-else-if="showImages && hasTrackers && !loadEverything"
			class="mb-2 px-3 py-2 rounded bg-bg-surface text-xs flex items-center justify-between"
		>
			<span class="text-text-secondary inline-flex items-center gap-1.5">
				<Icon name="lucide:shield" class="w-3.5 h-3.5 flex-shrink-0" />
				{{ trackerPixelLabel(trackerDetection.pixelCount) }}
				kept blocked.
			</span>
			<button
				type="button"
				class="text-text-tertiary font-medium hover:underline"
				@click="loadEverything = true"
			>
				Load everything
			</button>
		</div>
		<!-- Wrapper background matches the iframe scheme so dark-rendered mail
		     never flashes a white full-bleed; "designed" mail keeps its own
		     colors as a light paper card on the dark app background. -->
		<iframe
			ref="iframeRef"
			:srcdoc="displaySrcdoc"
			sandbox=""
			class="w-full rounded border border-border-subtle"
			:class="renderScheme === 'dark' ? '' : 'bg-white'"
			:style="{
				minHeight: '200px',
				height: presetHeight ? `${presetHeight}px` : undefined,
				backgroundColor: renderScheme === 'dark' ? POSTBOX_DARK_PALETTE.background : undefined,
			}"
			referrerpolicy="no-referrer"
		/>
		<button
			v-if="hasQuotedContent"
			type="button"
			class="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-surface"
			@click="showQuoted = !showQuoted"
		>
			<Icon
				:name="showQuoted ? 'lucide:chevron-up' : 'lucide:chevron-down'"
				class="w-3.5 h-3.5"
			/>
			{{ showQuoted ? 'Hide quoted text' : 'Show quoted text' }}
		</button>
	</div>
</template>
