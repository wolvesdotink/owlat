import { extractMimePartBlob } from '~/composables/useMimePartDownload';
import { loadMessagePart } from '~/composables/postbox/loadMessagePart';
import { loadRawEml } from '~/composables/postbox/loadRawEml';
import { inlineImageParts, normalizeContentId, type CidAttachment } from '~/utils/postboxCidImages';
import type { AttachmentMeta } from '~/utils/attachmentMeta';

/**
 * Load the inline (`cid:`) images a message body references, as `data:` URLs
 * keyed by normalized Content-ID (see utils/postboxCidImages).
 *
 * Each part comes through the same two paths a download takes: the part stored
 * on its own, else the raw `.eml` with the part cut out. A part that fails to
 * load is left out, and its image stays as broken as it was before.
 *
 * `pending` is true while parts are on their way, so the body can hold off
 * caching (and persisting offline) a render that still has holes in it.
 */

type PartLoader = (messageId: string, att: AttachmentMeta) => Promise<Blob | null>;

/** Resolved images across messages, so reopening a thread does not refetch them. */
const DATA_URL_CACHE_LIMIT = 50;
const dataUrlCache = new Map<string, string>();

function cacheDataUrl(key: string, url: string) {
	dataUrlCache.delete(key);
	dataUrlCache.set(key, url);
	if (dataUrlCache.size > DATA_URL_CACHE_LIMIT) {
		const oldest = dataUrlCache.keys().next().value;
		if (oldest !== undefined) dataUrlCache.delete(oldest);
	}
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener('load', () => resolve(String(reader.result)));
		reader.addEventListener('error', () => reject(reader.error));
		reader.readAsDataURL(blob);
	});
}

const defaultLoadPart: PartLoader = (messageId, att) =>
	extractMimePartBlob(messageId, att, { loadPart: loadMessagePart, loadRaw: loadRawEml });

export function usePostboxCidImages(
	source: () => {
		messageId?: string;
		html: string | null | undefined;
		attachments?: readonly CidAttachment[];
	},
	options: { loadPart?: PartLoader } = {}
) {
	const loadPart = options.loadPart ?? defaultLoadPart;
	const urls = shallowRef<ReadonlyMap<string, string>>(new Map());
	const pending = ref(false);

	const wanted = computed(() => {
		const { messageId, html, attachments } = source();
		return messageId ? { messageId, parts: inlineImageParts(attachments, html) } : null;
	});
	const wantedKey = computed(() =>
		wanted.value
			? `${wanted.value.messageId}|${wanted.value.parts.map((p) => p.contentId).join('|')}`
			: ''
	);

	const cacheKey = (messageId: string, att: CidAttachment) =>
		`${messageId}:${normalizeContentId(att.contentId ?? '')}`;

	async function loadOne(messageId: string, att: CidAttachment): Promise<[string, string] | null> {
		const id = normalizeContentId(att.contentId ?? '');
		const key = cacheKey(messageId, att);
		try {
			const blob = await loadPart(messageId, att);
			if (!blob) return null;
			// The part's own type, unless it came back untyped: only images are
			// handed to an <img>.
			const type = blob.type.toLowerCase().startsWith('image/') ? blob.type : att.contentType;
			if (!type.toLowerCase().startsWith('image/')) return null;
			const url = await blobToDataUrl(blob.type === type ? blob : new Blob([blob], { type }));
			cacheDataUrl(key, url);
			return [id, url];
		} catch {
			return null;
		}
	}

	let sequence = 0;
	watch(
		wantedKey,
		async () => {
			const request = ++sequence;
			const current = wanted.value;
			if (!current || current.parts.length === 0) {
				urls.value = new Map();
				pending.value = false;
				return;
			}
			// Parts already resolved this session apply at once; the rest load. The
			// map is rebuilt rather than extended so a Content-ID the previous
			// message used (plenty of senders call it `logo`) never leaks across.
			const resolved = new Map<string, string>();
			const missing: CidAttachment[] = [];
			for (const part of current.parts) {
				const hit = dataUrlCache.get(cacheKey(current.messageId, part));
				if (hit) resolved.set(normalizeContentId(part.contentId ?? ''), hit);
				else missing.push(part);
			}
			urls.value = resolved;
			if (missing.length === 0) {
				pending.value = false;
				return;
			}
			pending.value = true;
			const loaded = await Promise.all(missing.map((p) => loadOne(current.messageId, p)));
			if (request !== sequence) return;
			for (const entry of loaded) if (entry) resolved.set(entry[0], entry[1]);
			urls.value = new Map(resolved);
			pending.value = false;
		},
		{ immediate: true }
	);

	return { urls, pending };
}
