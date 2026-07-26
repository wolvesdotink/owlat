import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ConvexClient } from 'convex/browser';

export type PostboxBodyClient = Pick<ConvexClient, 'action'>;

export type ResolvedPostboxBody = {
	html: string | null;
	text: string | null;
} | null;

type BodySource = {
	htmlInline: string | null;
	textInline: string | null;
	htmlUrl: string | null;
	textUrl: string | null;
} | null;

type BodyFetch = (url: string) => Promise<{
	ok?: boolean;
	text(): Promise<string>;
}>;

const MAX_RESOLVED_BODIES_PER_CLIENT = 6;
const MAX_RESOLVED_BODY_CHARS = 512 * 1024;
const MAX_RESOLVED_BODY_CACHE_CHARS = 2 * 1024 * 1024;

interface ResolvedBodyCacheEntry {
	promise: Promise<ResolvedPostboxBody>;
	charCount: number;
}

interface ResolvedBodyCache {
	entries: Map<string, ResolvedBodyCacheEntry>;
	charCount: number;
}

const resolvedBodies = new WeakMap<PostboxBodyClient, ResolvedBodyCache>();

function removeCachedBody(cache: ResolvedBodyCache, messageId: string): void {
	const entry = cache.entries.get(messageId);
	if (!entry) return;
	cache.entries.delete(messageId);
	cache.charCount = Math.max(0, cache.charCount - entry.charCount);
}

function resolvedBodyCharCount(body: ResolvedPostboxBody): number {
	return (body?.html?.length ?? 0) + (body?.text?.length ?? 0);
}

async function loadPostboxBody(
	client: PostboxBodyClient,
	messageId: string,
	fetchImpl: BodyFetch
): Promise<ResolvedPostboxBody> {
	const source = (await client.action(api.mail.mailbox.getMessageBody, {
		messageId: messageId as Id<'mailMessages'>,
	})) as BodySource;
	if (!source) return null;
	let html = source.htmlInline;
	let text = source.textInline;
	const bodyUrl = html === null && text === null ? (source.htmlUrl ?? source.textUrl) : null;
	if (bodyUrl) {
		const response = await fetchImpl(bodyUrl);
		if (response.ok === false) throw new Error('Could not load message body');
		const body = await response.text();
		if (source.htmlUrl) html = body;
		else text = body;
	}
	return { html, text };
}

/** Resolve and cache the complete body, not its short-lived signed URL. The
 * client-scoped LRU lets list prefetch and the reader share one action/blob
 * request without allowing one authenticated client to reuse another's data. */
export function resolvePostboxMessageBody(
	client: PostboxBodyClient,
	messageId: string,
	fetchImpl: BodyFetch = (url) => fetch(url)
): Promise<ResolvedPostboxBody> {
	let cache = resolvedBodies.get(client);
	if (!cache) {
		cache = { entries: new Map(), charCount: 0 };
		resolvedBodies.set(client, cache);
	}
	const existing = cache.entries.get(messageId);
	if (existing) {
		cache.entries.delete(messageId);
		cache.entries.set(messageId, existing);
		return existing.promise;
	}
	const entry: ResolvedBodyCacheEntry = {
		promise: Promise.resolve(null),
		charCount: 0,
	};
	entry.promise = loadPostboxBody(client, messageId, fetchImpl)
		.then((body) => {
			if (cache?.entries.get(messageId) !== entry) return body;
			const charCount = resolvedBodyCharCount(body);
			if (charCount > MAX_RESOLVED_BODY_CHARS) {
				removeCachedBody(cache, messageId);
				return body;
			}
			entry.charCount = charCount;
			cache.charCount += charCount;
			while (cache.charCount > MAX_RESOLVED_BODY_CACHE_CHARS) {
				const oldest = cache.entries.keys().next().value;
				if (oldest === undefined) break;
				removeCachedBody(cache, oldest);
			}
			return body;
		})
		.catch((error) => {
			if (cache?.entries.get(messageId) === entry) removeCachedBody(cache, messageId);
			throw error;
		});
	cache.entries.set(messageId, entry);
	while (cache.entries.size > MAX_RESOLVED_BODIES_PER_CLIENT) {
		const oldest = cache.entries.keys().next().value;
		if (oldest === undefined) break;
		removeCachedBody(cache, oldest);
	}
	return entry.promise;
}

/** Consume a prefetched result once, then remove the decrypted body from the
 * client cache. Concurrent consumers still share the same in-flight promise. */
export async function consumeResolvedPostboxMessageBody(
	client: PostboxBodyClient,
	messageId: string,
	fetchImpl: BodyFetch = (url) => fetch(url)
): Promise<ResolvedPostboxBody> {
	const pending = resolvePostboxMessageBody(client, messageId, fetchImpl);
	try {
		return await pending;
	} finally {
		const cache = resolvedBodies.get(client);
		if (cache?.entries.get(messageId)?.promise === pending) {
			removeCachedBody(cache, messageId);
		}
	}
}

export function clearResolvedPostboxBodies(client: PostboxBodyClient): void {
	resolvedBodies.delete(client);
}
