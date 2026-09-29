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
/** How long a body the reader has read stays cached, so re-opening it (back,
 * j/k past it and back, a reply that quotes it) needs no second round trip. */
export const CONSUMED_POSTBOX_BODY_TTL_MS = 2 * 60 * 1000;

interface ResolvedBodyCacheEntry {
	promise: Promise<ResolvedPostboxBody>;
	charCount: number;
	/** Set once a reader consumes the body; null while it is only prefetched. */
	expiresAt: number | null;
	expiryTimer: ReturnType<typeof setTimeout> | null;
}

interface ResolvedBodyCache {
	entries: Map<string, ResolvedBodyCacheEntry>;
	charCount: number;
	/** Who and which mailbox the entries belong to; see setResolvedPostboxBodyScope. */
	scope: string | null;
}

const resolvedBodies = new WeakMap<PostboxBodyClient, ResolvedBodyCache>();

function cacheFor(client: PostboxBodyClient): ResolvedBodyCache {
	let cache = resolvedBodies.get(client);
	if (!cache) {
		cache = { entries: new Map(), charCount: 0, scope: null };
		resolvedBodies.set(client, cache);
	}
	return cache;
}

function removeCachedBody(cache: ResolvedBodyCache, messageId: string): void {
	const entry = cache.entries.get(messageId);
	if (!entry) return;
	if (entry.expiryTimer !== null) clearTimeout(entry.expiryTimer);
	cache.entries.delete(messageId);
	cache.charCount = Math.max(0, cache.charCount - entry.charCount);
}

function dropAllCachedBodies(cache: ResolvedBodyCache): void {
	for (const messageId of Array.from(cache.entries.keys())) removeCachedBody(cache, messageId);
}

function resolvedBodyCharCount(body: ResolvedPostboxBody): number {
	return (body?.html?.length ?? 0) + (body?.text?.length ?? 0);
}

async function loadPostboxBody(
	client: PostboxBodyClient,
	messageId: string,
	fetchImpl: BodyFetch
): Promise<ResolvedPostboxBody> {
	const source = (await client.action(api.mail.mailbox.messages.getMessageBody, {
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
	const cache = cacheFor(client);
	const existing = cache.entries.get(messageId);
	if (existing && existing.expiresAt !== null && existing.expiresAt <= Date.now()) {
		removeCachedBody(cache, messageId);
	} else if (existing) {
		cache.entries.delete(messageId);
		cache.entries.set(messageId, existing);
		return existing.promise;
	}
	const entry: ResolvedBodyCacheEntry = {
		promise: Promise.resolve(null),
		charCount: 0,
		expiresAt: null,
		expiryTimer: null,
	};
	entry.promise = loadPostboxBody(client, messageId, fetchImpl)
		.then((body) => {
			if (cache.entries.get(messageId) !== entry) return body;
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
			if (cache.entries.get(messageId) === entry) removeCachedBody(cache, messageId);
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

/** Read a body for display. A prefetched result is reused, and the resolved
 * body then stays cached for CONSUMED_POSTBOX_BODY_TTL_MS (within the entry and
 * byte caps above) before the decrypted copy is dropped. Reading it again
 * restarts that window. Concurrent consumers share the same in-flight promise. */
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
		const entry = cache?.entries.get(messageId);
		if (cache && entry?.promise === pending) {
			if (entry.expiryTimer !== null) clearTimeout(entry.expiryTimer);
			entry.expiresAt = Date.now() + CONSUMED_POSTBOX_BODY_TTL_MS;
			entry.expiryTimer = setTimeout(() => {
				if (cache.entries.get(messageId) === entry) removeCachedBody(cache, messageId);
			}, CONSUMED_POSTBOX_BODY_TTL_MS);
		}
	}
}

/**
 * Tie the cache to who is reading which mailbox. The key is opaque (the
 * caller builds it from user, organization and mailbox); a key that differs
 * from the previous one drops every cached body first, so switching mailbox,
 * account or organization never serves the old context's mail.
 */
export function setResolvedPostboxBodyScope(client: PostboxBodyClient, scope: string): void {
	const cache = cacheFor(client);
	if (cache.scope !== null && cache.scope !== scope) dropAllCachedBodies(cache);
	cache.scope = scope;
}

/** Drop every cached body (and the scope) for this client: sign-out and any
 * other session change. */
export function clearResolvedPostboxBodies(client: PostboxBodyClient): void {
	const cache = resolvedBodies.get(client);
	if (cache) dropAllCachedBodies(cache);
	resolvedBodies.delete(client);
}
