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
	() => needsBodyFetch.value && !bodyFetchSettled.value && !bodyError.value
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

// Adaptive dark rendering: classify the sanitized HTML and decide the iframe
// scheme. Runs AFTER sanitization on the sanitized string only; when the app
// is light (or the message is forced light) it's a pass-through no-op.
const adapted = computed(() => {
	const split = quotedSplit.value;
	const fresh = sanitize(split.fresh);
	const quoted = showQuoted.value ? sanitize(split.quoted) : '';
	const combined = quoted ? `${fresh}<hr style="margin:1em 0;border:0;border-top:1px solid #eee">${quoted}` : fresh;
	return adaptEmailHtml(combined, appScheme.value);
});

// Scheme the iframe actually renders with ("designed" mail stays light —
// a paper card on the dark app background — even when the app is dark).
const renderScheme = computed(() => adapted.value.scheme);

// Tracking-pixel detection on the SANITIZED output only (never raw mail
// HTML). Pure + fail-soft: a detector error reports zero trackers and the
// reader behaves exactly as it did without this feature.
const trackerDetection = computed<TrackerDetection>(() =>
	detectTrackers(adapted.value.html)
);
const hasTrackers = computed(() => trackerDetection.value.pixelCount > 0);

watch(
	trackerDetection,
	(detection) => emit('trackers', detection),
	{ immediate: true }
);

const srcdoc = computed(() => {
	let html = adapted.value.html;
	// "Show images" loads real content but keeps probable tracking pixels
	// stripped; "Load everything" is the explicit escalation past that.
	if (showImages.value && !loadEverything.value && hasTrackers.value) {
		html = stripTrackerPixels(html);
	}
	const gated = gateImages(html, showImages.value);
	// Link transparency (real-host tooltips, phish-mismatch markers, tracking
	// param stripping) runs on sanitized output only and fails soft to a no-op.
	const linked = rewriteLinks(applyLinkTransparency(gated));
	return `<!doctype html><html><head>${META_CSP}${buildBaseStyle(renderScheme.value, adapted.value.kind)}</head><body>${linked || '(empty message)'}</body></html>`;
});

const hasBlockedImages = computed(
	() => !showImages.value && /<img\s/i.test(effectiveHtml.value ?? '')
);
const hasQuotedContent = computed(() => quotedSplit.value.hasQuote);

// Auto-resize iframe to content height
function resizeIframe() {
	const iframe = iframeRef.value;
	if (!iframe?.contentDocument) return;
	const h = iframe.contentDocument.documentElement.scrollHeight;
	iframe.style.height = `${Math.max(120, h)}px`;
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
			:srcdoc="srcdoc"
			sandbox=""
			class="w-full rounded border border-border-subtle"
			:class="renderScheme === 'dark' ? '' : 'bg-white'"
			:style="{
				minHeight: '200px',
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
