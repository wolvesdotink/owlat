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
 * message part from (`loadMessagePart`). They are asked for when the draft or
 * the set of images in its body changes, and again shortly before the first of
 * them expires, so an editor left open for hours keeps its images. A failed ask
 * keeps the URLs it has and tries again a minute later.
 */

import { computed, onScopeDispose, shallowRef, watch, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { EXPIRY_MARGIN_MS, tokenExpiry } from './loadMessagePart';

/** How long after a failed ask to try again, and the shortest wait between asks. */
const RETRY_MS = 60_000;

type InlineImageUrl = { contentId: string; url: string };
type MintUrls = (draftId: Id<'mailDrafts'>) => Promise<InlineImageUrl[]>;

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
	options: { mint?: MintUrls; now?: () => number } = {}
) {
	const mint = options.mint ?? defaultMint;
	const now = options.now ?? Date.now;
	const sources = shallowRef<ReadonlyMap<string, string>>(new Map());

	// Typing changes the body, not this key: only a new draft or image asks again.
	const wanted = computed(() => {
		const cids = inlineContentIds(bodyHtml.value);
		return draftId.value && cids.length > 0 ? `${draftId.value}|${cids.join('|')}` : '';
	});

	let timer: ReturnType<typeof setTimeout> | null = null;
	let sequence = 0;
	function schedule(delayMs: number) {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void load(), Math.max(0, delayMs));
	}
	function cancel() {
		if (timer) clearTimeout(timer);
		timer = null;
	}

	async function load() {
		cancel();
		const request = ++sequence;
		const id = draftId.value;
		if (!id || !wanted.value) {
			sources.value = new Map();
			return;
		}
		let answer: InlineImageUrl[] | null;
		try {
			answer = await mint(id);
		} catch {
			answer = null;
		}
		if (request !== sequence) return;
		if (!answer) {
			schedule(RETRY_MS);
			return;
		}
		sources.value = new Map(answer.map((part) => [part.contentId, part.url]));
		// A URL without an expiry (an instance with no sealing key) never needs renewing.
		const expiries = answer.flatMap((part) => tokenExpiry(part.url) ?? []);
		// Never sooner than a retry, so a skewed clock cannot turn this into a loop.
		if (expiries.length > 0) {
			schedule(Math.max(RETRY_MS, Math.min(...expiries) - EXPIRY_MARGIN_MS - now()));
		}
	}

	watch(wanted, () => void load(), { immediate: true });
	onScopeDispose(() => {
		sequence += 1;
		cancel();
	});

	return sources;
}
