/**
 * Where the composer shows a draft's inline body images from (#1285).
 *
 * A pasted image is saved as `<img data-inline-cid="X">` with no `src`, its
 * bytes as the inline part `X` on the draft row. The preview the paste showed
 * does not survive a reload or reach another device, so the editor shows each
 * image from a URL the server mints for its part (`mail.draftInlineImages.urls`,
 * gated like `drafts.get`). Those are expiring `/sealed-blob` URLs, the same
 * kind the reader loads a message part from, so they are renewed.
 *
 * One small state machine per draft does the asking. Every trigger (opening
 * the draft, the timer, the tab becoming visible or focused, a new image in the
 * body) calls `kick`, and `kick` starts at most one request:
 *
 *   - never while one is in flight (images new meanwhile are asked for in one
 *     request right after it);
 *   - otherwise only once `nextAttemptAt` has passed, except for the timer
 *     (armed to exactly that time) and an image never asked for in this draft,
 *     which asks at once. Putting back an image that was there before (undo
 *     after a delete) is not new: it waits like everything else.
 *
 * A complete answer sets `nextAttemptAt` from the lifetime the server reports
 * (`expiresInMs`, counted from when the answer arrived: five minutes early and
 * at most 50 minutes on), so the device clock is never compared with the
 * server's. A failed answer, or one that leaves an image unresolved (an empty
 * answer during a passing auth loss, say), backs off from `RETRY_MS` doubling
 * to `MAX_RETRY_MS`, keeping the URLs already held. A tab that slept past
 * `nextAttemptAt` asks once when it wakes. Wall-clock time is used for that on
 * purpose: `performance.now()` can stand still while the machine sleeps, which
 * would hide an overdue wake. Each request first waits for Convex auth, so it
 * never asks as an anonymous caller.
 *
 * The answer names its composition (`scope`): an id made here, once. The
 * composer is one composition (every host keys it per compose request, message
 * or window), and it keys the editor by this id, so the id survives the draft
 * getting its first row id and never moves under a mounted editor. Should the
 * composer's draft change to another row anyway, the request state starts
 * over: the URLs are cleared, and the answer of a request still in flight for
 * the previous row is dropped.
 */

import { computed, onScopeDispose, shallowRef, watch, type Ref } from 'vue';
import type { InlineImageSources } from './usePostboxInlineImages';
import { composeRandomId } from './usePostboxComposeNav';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { whenConvexAuthenticated } from '~/lib/convexAuthReady';

/** Renew this long before the server's expiry. */
const RENEW_MARGIN_MS = 5 * 60_000;
/** Never wait longer than this between renewals, whatever the lifetime says. */
const MAX_RENEW_MS = 50 * 60_000;
/** The first retry after a failed or incomplete answer. */
const RETRY_MS = 15_000;
/** Retries back off up to this. */
const MAX_RETRY_MS = 5 * 60_000;
/** How long one request waits for Convex auth before it counts as failed. */
const AUTH_WAIT_MS = 30_000;

type InlineImageUrl = { contentId: string; url: string; expiresInMs?: number };
type MintUrls = (draftId: Id<'mailDrafts'>) => Promise<InlineImageUrl[]>;
type WhenAuthenticated = (timeoutMs: number, signal: AbortSignal) => Promise<boolean>;
type KickReason = 'open' | 'timer' | 'resume' | 'new-image';

const defaultMint: MintUrls = (draftId) =>
	requireConvex().action(api.mail.draftInlineImages.urls, { draftId });

/** The Content-IDs of the inline images a body holds, sorted, without repeats. */
function inlineContentIds(html: string): string[] {
	const ids = new Set<string>();
	for (const match of html.matchAll(/data-inline-cid="([^"]+)"/g)) ids.add(match[1]!);
	return [...ids].sort();
}

/** The wait after the `failures`-th failure in a row: 15 s, doubling, at most 5 min. */
function backoff(failures: number): number {
	return Math.min(RETRY_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_MS);
}

export function usePostboxDraftInlineImages(
	draftId: Readonly<Ref<Id<'mailDrafts'> | null>>,
	bodyHtml: Readonly<Ref<string>>,
	options: { mint?: MintUrls; whenAuthenticated?: WhenAuthenticated; now?: () => number } = {}
) {
	const mint = options.mint ?? defaultMint;
	const whenAuthenticated = options.whenAuthenticated ?? whenConvexAuthenticated;
	const now = options.now ?? Date.now;
	const urls = shallowRef<ReadonlyMap<string, string>>(new Map());
	const composition = composeRandomId();
	const contentIds = computed(() => inlineContentIds(bodyHtml.value));

	// The state of the current draft. `generation` changes with the draft (and
	// on dispose); a request only touches the state of the generation it began in.
	let generation = 0;
	let inFlight = false;
	/** Every Content-ID a request of this draft has asked for. */
	let requested = new Set<string>();
	let nextAttemptAt = 0;
	let failureCount = 0;
	let abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	function clearTimer() {
		if (timer) clearTimeout(timer);
		timer = null;
	}
	/** The one timer, always aimed at `nextAttemptAt`. */
	function armTimer() {
		clearTimer();
		if (!Number.isFinite(nextAttemptAt)) return;
		timer = setTimeout(() => kick('timer'), Math.max(0, nextAttemptAt - now()));
	}

	/** Whether the body holds an image no request of this draft has asked for. */
	const hasUnaskedImage = () => contentIds.value.some((cid) => !requested.has(cid));

	/** The single way a request starts. */
	function kick(reason: KickReason) {
		const id = draftId.value;
		if (disposed || inFlight || !id || contentIds.value.length === 0) return;
		const due =
			reason === 'timer' || (reason === 'new-image' && hasUnaskedImage()) || now() >= nextAttemptAt;
		if (!due) return;
		void request(id, generation);
	}

	async function request(id: Id<'mailDrafts'>, mine: number) {
		inFlight = true;
		for (const cid of contentIds.value) requested.add(cid);
		clearTimer();
		const { signal } = abort;
		let answer: InlineImageUrl[] | null = null;
		try {
			// An anonymous ask answers [] and would leave every image unresolved.
			const authenticated = await whenAuthenticated(AUTH_WAIT_MS, signal);
			if (authenticated && mine === generation && !signal.aborted) answer = await mint(id);
		} catch {
			answer = null;
		}
		// Another draft (or none) since: this answer belongs to nobody.
		if (mine !== generation) return;
		inFlight = false;
		const receivedAt = now();
		if (answer) {
			const next = new Map(urls.value);
			for (const part of answer) next.set(part.contentId, part.url);
			urls.value = next;
		}
		const lifetimes = (answer ?? []).flatMap((part) => part.expiresInMs ?? []);
		const renewAt =
			lifetimes.length > 0
				? receivedAt + Math.min(Math.min(...lifetimes) - RENEW_MARGIN_MS, MAX_RENEW_MS)
				: Infinity;
		const answered = new Set((answer ?? []).map((part) => part.contentId));
		const complete = answer !== null && contentIds.value.every((cid) => answered.has(cid));
		if (complete) {
			failureCount = 0;
			nextAttemptAt = renewAt;
		} else {
			failureCount += 1;
			nextAttemptAt = Math.min(renewAt, receivedAt + backoff(failureCount));
		}
		armTimer();
		// Images added while this was in flight go out together, in one request.
		kick('new-image');
	}

	/** Back from sleep or a background tab. */
	function onResume() {
		if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
		kick('resume');
	}
	if (typeof window !== 'undefined') {
		window.addEventListener('focus', onResume);
		document.addEventListener('visibilitychange', onResume);
	}

	/** Start over for another draft: no URLs, no request, no backoff. */
	function reset() {
		generation += 1;
		abort.abort();
		abort = new AbortController();
		clearTimer();
		inFlight = false;
		requested = new Set();
		nextAttemptAt = 0;
		failureCount = 0;
		urls.value = new Map();
	}

	watch(
		draftId,
		() => {
			reset();
			kick('open');
		},
		{ immediate: true }
	);
	// Only a change in the set of images, not every keystroke.
	watch(
		() => contentIds.value.join('|'),
		() => kick('new-image')
	);

	onScopeDispose(() => {
		disposed = true;
		generation += 1;
		abort.abort();
		clearTimer();
		if (typeof window !== 'undefined') {
			window.removeEventListener('focus', onResume);
			document.removeEventListener('visibilitychange', onResume);
		}
	});

	return computed<InlineImageSources>(() => ({ scope: composition, urls: urls.value }));
}
