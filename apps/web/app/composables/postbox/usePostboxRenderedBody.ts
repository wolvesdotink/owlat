import { computed, onScopeDispose, shallowRef, watch } from 'vue';
import type { TrackerDetection } from '@owlat/shared/postboxTrackers';
import { buildBaseStyle } from '~/utils/postboxBaseStyle';
import {
	POSTBOX_BODY_META_CSP,
	POSTBOX_BODY_META_CSP_NO_REMOTE,
	POSTBOX_SRCDOC_HEAD,
} from '~/utils/postboxBodyPlaceholder';
import type { PostboxRenderScheme } from '~/utils/postboxDarkMode';
import {
	getPostboxRenderCache,
	postboxRenderKey,
	type PostboxRenderEntry,
} from '~/utils/postboxRenderCache';
import {
	renderPostboxBodyStage,
	type PostboxRenderStageInput,
	type PostboxRenderStageOutput,
} from '~/utils/postboxRenderPipeline';
import { applyPostboxImageConsent } from '~/utils/postboxRemoteResources';
import { getPostboxRenderClient, type PostboxRenderJob } from '~/lib/postboxRenderWorker';

/**
 * The rendered document for one message body, produced off the main thread.
 *
 * The string pipeline (utils/postboxRenderPipeline) runs in the shared render
 * worker; remote-image consent and the srcdoc assembly run here once it
 * answers, because the consent pass parses into a DOM `<template>`. The final
 * entry goes into the session LRU (utils/postboxRenderCache) under a key of
 * every option that changes it, so re-opening a message is a synchronous hit
 * that never reaches the worker.
 *
 * Every input change starts a new generation and cancels the request before
 * it; an answer from an older generation, or one arriving after unmount, is
 * dropped. Until the first render of the current body is in, `entry` is null
 * and the reader shows its skeleton; a re-render of the SAME body (a theme or
 * quote toggle) keeps the previous document on screen instead, re-finished
 * under the current image consent so a revoked consent never lingers while the
 * worker runs. Consent changes re-run only the main-thread stage over the last
 * pipeline output, which a cache hit restores from the cached entry.
 */

export interface PostboxRenderedBodySource {
	messageId: string | undefined;
	html: string;
	text: string;
	scheme: PostboxRenderScheme;
	showQuoted: boolean;
	showImages: boolean;
	loadEverything: boolean;
	cidUrls: ReadonlyMap<string, string>;
	/** Body and inline images are complete, so the render may be cached and kept. */
	final: boolean;
	/** Replaces an image withheld under "blocked" consent. */
	blockedImageLabel: string;
	/** Body of a message with no content. */
	emptyLabel: string;
}

export type PostboxRenderedEntry = Omit<PostboxRenderEntry, 'height'>;

interface ShownRender {
	/** The inputs `entry` was finished under (body and consent). */
	source: PostboxRenderedBodySource;
	/** Cache key of `entry`, or null when it belongs to no key (re-finished). */
	key: string | null;
	final: boolean;
	entry: PostboxRenderedEntry;
}

// A render that failed twice (worker and main thread) shows the empty-message
// document: never the raw body, and never cached or kept offline.
const FAILED_STAGE: PostboxRenderStageOutput = {
	html: '',
	scheme: 'light',
	kind: 'simple',
	hasQuote: false,
};

function sameMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
	if (a === b) return true;
	if (a.size !== b.size) return false;
	for (const [k, v] of a) if (b.get(k) !== v) return false;
	return true;
}

function sameBody(a: PostboxRenderedBodySource, b: PostboxRenderedBodySource): boolean {
	return a.messageId === b.messageId && a.html === b.html && a.text === b.text;
}

/** Everything the main-thread stage reads besides the pipeline output. */
function sameFinish(a: PostboxRenderedBodySource, b: PostboxRenderedBodySource): boolean {
	return (
		a.showImages === b.showImages &&
		a.loadEverything === b.loadEverything &&
		a.blockedImageLabel === b.blockedImageLabel &&
		a.emptyLabel === b.emptyLabel
	);
}

function sameStageInput(a: PostboxRenderStageInput, b: PostboxRenderStageInput): boolean {
	return (
		a.html === b.html &&
		a.text === b.text &&
		a.showQuoted === b.showQuoted &&
		a.scheme === b.scheme &&
		sameMap(a.cidUrls, b.cidUrls)
	);
}

/** Remote-image consent and the iframe document, over the pipeline's output. */
function finishRender(
	stage: PostboxRenderStageOutput,
	source: PostboxRenderedBodySource
): PostboxRenderedEntry {
	// Remote-resource consent runs last, over the SANITIZED output only (never
	// raw mail): one inventory of every img src, srcset candidate and CSS
	// background gates the body and counts the trackers. "Show images" loads
	// real content but keeps probable tracking pixels stripped; "Load
	// everything" is the explicit escalation past that.
	const consent = !source.showImages ? 'blocked' : source.loadEverything ? 'everything' : 'images';
	const gated = applyPostboxImageConsent(stage.html, consent, source.blockedImageLabel);
	// Until the user consents, the frame's policy admits no remote image at
	// all, whatever spelling the reference uses; nor does it when the body
	// could not be inventoried.
	const csp =
		source.showImages && !gated.noRemote ? POSTBOX_BODY_META_CSP : POSTBOX_BODY_META_CSP_NO_REMOTE;
	const srcdoc = `${POSTBOX_SRCDOC_HEAD}${csp}${buildBaseStyle(stage.scheme, stage.kind)}</head><body>${gated.html || source.emptyLabel}</body></html>`;
	return {
		srcdoc,
		renderScheme: stage.scheme,
		kind: stage.kind,
		detection: gated.detection,
		hasRemoteImages: gated.hasRemoteResources,
		inventoryFailed: gated.noRemote,
		hasQuote: stage.hasQuote,
		stage,
	};
}

const NO_TRACKERS: TrackerDetection = { pixelCount: 0, trackerHosts: [] };

export function usePostboxRenderedBody(source: () => PostboxRenderedBodySource) {
	const current = computed(source);
	const shown = shallowRef<ShownRender | null>(null);
	/** A request for the current inputs is still running. */
	const pending = shallowRef(false);
	let generation = 0;
	let job: PostboxRenderJob | null = null;
	let lastStage: { input: PostboxRenderStageInput; output: PostboxRenderStageOutput } | null = null;

	const renderKey = computed(() => {
		const s = current.value;
		return s.messageId
			? postboxRenderKey(s.messageId, {
					scheme: s.scheme,
					showImages: s.showImages,
					loadEverything: s.loadEverything,
					showQuoted: s.showQuoted,
				})
			: null;
	});

	function show(
		s: PostboxRenderedBodySource,
		key: string | null,
		entry: PostboxRenderedEntry,
		final: boolean
	) {
		shown.value = { source: s, key, final, entry };
		pending.value = false;
	}

	function accept(
		s: PostboxRenderedBodySource,
		key: string | null,
		stage: PostboxRenderStageOutput | null
	) {
		const entry = finishRender(stage ?? FAILED_STAGE, s);
		// Only a complete body is memoised or kept: a transient loading state, or
		// a failed render, must never be served later under a real key.
		const final = s.final && stage !== null;
		if (key !== null && final) getPostboxRenderCache().set(key, { ...entry, height: null });
		show(s, key, entry, final);
	}

	function runOnMainThread(
		s: PostboxRenderedBodySource,
		key: string | null,
		input: PostboxRenderStageInput
	) {
		let output: PostboxRenderStageOutput | null = null;
		try {
			output = renderPostboxBodyStage(input);
			lastStage = { input, output };
		} catch {
			output = null;
		}
		accept(s, key, output);
	}

	function update() {
		const gen = ++generation;
		job?.cancel();
		job = null;
		const s = current.value;
		const key = renderKey.value;
		const input: PostboxRenderStageInput = {
			html: s.html,
			text: s.text,
			showQuoted: s.showQuoted,
			scheme: s.scheme,
			// A snapshot: the caller may fill its map in place after handing it over.
			cidUrls: new Map(s.cidUrls),
		};
		const prev = shown.value;
		// Another body's document is never shown while this one renders.
		if (prev && !sameBody(prev.source, s)) shown.value = null;
		if (key && s.final) {
			const hit = getPostboxRenderCache().get(key);
			if (hit) {
				// The key fixes scheme and quote state, and a final body has all its
				// inline images, so the cached stage is the pipeline's output for
				// these inputs: a later consent change needs no worker request.
				lastStage = { input, output: hit.stage };
				show(s, key, hit, true);
				return;
			}
		}
		// A consent change keeps every pipeline input: only the main-thread stage reruns.
		if (lastStage && sameStageInput(lastStage.input, input)) {
			accept(s, key, lastStage.output);
			return;
		}
		const client = getPostboxRenderClient();
		if (!client) {
			runOnMainThread(s, key, input);
			return;
		}
		// The document kept on screen while the worker runs must honour the
		// current consent (revoked images stay out of the frame however long the
		// worker takes): re-finish its own stage under it. It belongs to no cache
		// key, so its measured height is not recorded against another render.
		const kept = shown.value;
		if (kept && !sameFinish(kept.source, s)) {
			shown.value = {
				source: s,
				key: null,
				final: false,
				entry: finishRender(kept.entry.stage, s),
			};
		}
		pending.value = true;
		const request = client.render(input);
		job = request;
		request.promise.then(
			(output) => {
				if (gen !== generation) return;
				job = null;
				lastStage = { input, output };
				accept(s, key, output);
			},
			() => {
				if (gen !== generation) return;
				job = null;
				// The worker could not answer: the same pipeline, on this thread.
				runOnMainThread(s, key, input);
			}
		);
	}

	// One getter per input, so a new message object carrying the same body
	// (every live-query update) does not restart the render.
	watch(
		[
			() => current.value.messageId,
			() => current.value.html,
			() => current.value.text,
			() => current.value.scheme,
			() => current.value.showQuoted,
			() => current.value.showImages,
			() => current.value.loadEverything,
			() => current.value.cidUrls,
			() => current.value.final,
			() => current.value.blockedImageLabel,
			() => current.value.emptyLabel,
		],
		update,
		{ immediate: true }
	);

	onScopeDispose(() => {
		generation += 1;
		job?.cancel();
		job = null;
	});

	const entry = computed(() => shown.value?.entry ?? null);
	return {
		/** The document to show, or null while the first render of this body runs. */
		entry,
		renderKey,
		/** Key the shown document was rendered under (for its measured height). */
		shownKey: computed(() => shown.value?.key ?? null),
		/** The shown document is the complete render of the current inputs. */
		settled: computed(() => !pending.value && shown.value !== null && shown.value.final),
		detection: computed(() => entry.value?.detection ?? NO_TRACKERS),
	};
}
