/**
 * Where the composer shows a draft's inline body images from (#1285).
 *
 * A pasted image is saved as `<img data-inline-cid="X">` with no `src`, its
 * bytes as the inline part `X` on the draft row. The preview the paste showed
 * does not survive a reload or reach another device, so the editor shows each
 * image from a URL the server mints for its part (`mail.draftInlineImages.urls`,
 * gated like `drafts.get`).
 *
 * Those are expiring `/sealed-blob` URLs, the same kind the reader loads a
 * message part from. They are asked for once Convex auth is confirmed, when the
 * draft or the set of images in its body changes, and again before they expire:
 *
 *   - Renewal is timed from the lifetime the server reports (`expiresInMs`),
 *     counted from when the answer arrived, and never later than
 *     `MAX_RENEW_MS`. The device clock is never compared with the server's
 *     expiry, so a clock that is off cannot push renewal past it.
 *   - A tab that slept past its renewal time (timers fire late or not at all)
 *     renews as soon as it is visible or focused again.
 *   - An answer that leaves an image unresolved (an empty answer during a
 *     passing auth loss, a part not on the row yet) is asked again with
 *     backoff, from `RETRY_MS` up to `MAX_RETRY_MS`, while the URLs it has stay.
 */

import { computed, onScopeDispose, shallowRef, watch, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { whenConvexAuthenticated } from '~/lib/convexAuthReady';

/** Renew this long before the server's expiry. */
const RENEW_MARGIN_MS = 5 * 60_000;
/** Never wait longer than this between renewals, whatever the lifetime says. */
const MAX_RENEW_MS = 50 * 60_000;
/** The first retry after a failed or incomplete answer, and the shortest wait between asks. */
const RETRY_MS = 15_000;
/** Retries back off up to this. */
const MAX_RETRY_MS = 5 * 60_000;
/** How long one ask waits for Convex auth before it counts as failed. */
const AUTH_WAIT_MS = 30_000;

type InlineImageUrl = { contentId: string; url: string; expiresInMs?: number };
type MintUrls = (draftId: Id<'mailDrafts'>) => Promise<InlineImageUrl[]>;
type WhenAuthenticated = (timeoutMs: number, signal: AbortSignal) => Promise<boolean>;

const defaultMint: MintUrls = (draftId) =>
	requireConvex().action(api.mail.draftInlineImages.urls, { draftId });

/** The Content-IDs of the inline images a body holds, sorted, without repeats. */
function inlineContentIds(html: string): string[] {
	const ids = new Set<string>();
	for (const match of html.matchAll(/data-inline-cid="([^"]+)"/g)) ids.add(match[1]!);
	return [...ids].sort();
}

export function usePostboxDraftInlineImages(
	draftId: Readonly<Ref<Id<'mailDrafts'> | null>>,
	bodyHtml: Readonly<Ref<string>>,
	options: { mint?: MintUrls; whenAuthenticated?: WhenAuthenticated; now?: () => number } = {}
) {
	const mint = options.mint ?? defaultMint;
	const whenAuthenticated = options.whenAuthenticated ?? whenConvexAuthenticated;
	const now = options.now ?? Date.now;
	const sources = shallowRef<ReadonlyMap<string, string>>(new Map());

	const contentIds = computed(() => inlineContentIds(bodyHtml.value));
	// Typing changes the body, not this key: only a new draft or image asks again.
	const wanted = computed(() =>
		draftId.value && contentIds.value.length > 0
			? `${draftId.value}|${contentIds.value.join('|')}`
			: ''
	);

	let timer: ReturnType<typeof setTimeout> | null = null;
	/** Local time by which the URLs held must be renewed; null when they need none. */
	let renewAt: number | null = null;
	let retryMs = RETRY_MS;
	let sequence = 0;
	let abort = new AbortController();

	function schedule(delayMs: number) {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void load(), Math.max(RETRY_MS, delayMs));
	}
	function cancel() {
		if (timer) clearTimeout(timer);
		timer = null;
		abort.abort();
		abort = new AbortController();
	}
	/** Ask again after the current backoff (sooner if renewal is due first), then back off. */
	function retryLater(renewIn: number | null = null) {
		schedule(renewIn === null ? retryMs : Math.min(retryMs, renewIn));
		retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
	}

	async function load() {
		cancel();
		const request = ++sequence;
		const id = draftId.value;
		if (!id || !wanted.value) {
			sources.value = new Map();
			renewAt = null;
			return;
		}
		const { signal } = abort;
		let answer: InlineImageUrl[] | null = null;
		try {
			// An anonymous ask answers [] and would leave every image unresolved.
			if (await whenAuthenticated(AUTH_WAIT_MS, signal)) answer = await mint(id);
		} catch {
			answer = null;
		}
		if (request !== sequence) return;
		if (!answer) {
			retryLater();
			return;
		}
		const receivedAt = now();
		const next = new Map(sources.value);
		for (const part of answer) next.set(part.contentId, part.url);
		sources.value = next;

		const lifetimes = answer.flatMap((part) => part.expiresInMs ?? []);
		const renewIn =
			lifetimes.length > 0
				? Math.min(Math.min(...lifetimes) - RENEW_MARGIN_MS, MAX_RENEW_MS)
				: null;
		renewAt = renewIn === null ? null : receivedAt + renewIn;
		const resolved = new Set(answer.map((part) => part.contentId));
		if (contentIds.value.some((cid) => !resolved.has(cid))) {
			retryLater(renewIn);
			return;
		}
		retryMs = RETRY_MS;
		if (renewIn !== null) schedule(renewIn);
	}

	/** Back from sleep or a background tab: renew at once if the time has passed. */
	function onResume() {
		if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
		if (renewAt !== null && now() >= renewAt) void load();
	}
	if (typeof window !== 'undefined') {
		window.addEventListener('focus', onResume);
		document.addEventListener('visibilitychange', onResume);
	}

	watch(
		wanted,
		() => {
			retryMs = RETRY_MS;
			void load();
		},
		{ immediate: true }
	);
	onScopeDispose(() => {
		sequence += 1;
		cancel();
		if (typeof window !== 'undefined') {
			window.removeEventListener('focus', onResume);
			document.removeEventListener('visibilitychange', onResume);
		}
	});

	return sources;
}
