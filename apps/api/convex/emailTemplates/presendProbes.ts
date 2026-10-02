'use node';

/**
 * Link and image probes for the pre-send checks (`presendChecksActions.run`).
 *
 * Every URL comes from an email an org member wrote, so every request goes
 * through the SSRF-safe path: the destination is validated against the
 * private/internal blocklist up front and again at connect time
 * (`lib/ssrfGuard`), and a redirect is followed by hand, one validated hop at a
 * time, instead of by `fetch`. Only the status (and an image's size) leaves this
 * module; no response body is ever read beyond what measuring an image takes.
 *
 * Links get a HEAD and, when HEAD is refused or fails, a GET whose body is
 * dropped unread: plenty of servers answer HEAD with 404 or 405 for pages that
 * load fine. Probes run a few at a time, each with its own timeout, inside one
 * overall budget so a page of slow hosts cannot hold the Review step; whatever
 * the budget did not reach comes back `skipped`.
 *
 * Results are cached per URL for a few minutes in the action runtime's memory,
 * so reopening the Review step or pressing "Check email" twice does not knock
 * on every host again. The cache is best effort (a cold runtime starts empty).
 */

import { validatePublicUrl, fetchWithGuardedDispatcher } from '../lib/ssrfGuard';
import { mapWithConcurrency } from '../lib/mapWithConcurrency';

export type ProbeStatus =
	/** 2xx, after any redirects. */
	| 'ok'
	/** 404/410/5xx or a redirect loop: the reader lands on an error. */
	| 'broken'
	/** 401/403/429: the host refused an automated check; a person may get through. */
	| 'unverified'
	/** DNS or connection failure. */
	| 'unreachable'
	/** Points at a private or internal address, which no reader can open either. */
	| 'blocked'
	| 'timeout'
	/** Not probed: the run's time budget ran out first. */
	| 'skipped';

export interface LinkProbe {
	url: string;
	status: ProbeStatus;
	httpStatus?: number;
}

export interface ImageProbe extends LinkProbe {
	/** Size in bytes, when the server said or the body could be measured. */
	bytes?: number;
	/** The body ran past the measuring cap, so `bytes` is a lower bound. */
	bytesAtLeast?: boolean;
}

const REQUEST_TIMEOUT_MS = 6_000;
/** The whole run's budget; probes not started by then are `skipped`. */
const RUN_BUDGET_MS = 25_000;
const MAX_REDIRECTS = 5;
const CONCURRENCY = 6;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 2_000;
/** An image body is read at most this far to measure it. */
export const IMAGE_MEASURE_CAP_BYTES = 5 * 1024 * 1024;

const REQUEST_HEADERS = { 'User-Agent': 'Owlat-LinkCheck/1.0', Accept: '*/*' };

const cache = new Map<string, { expiresAt: number; value: LinkProbe | ImageProbe }>();

function cached<T extends LinkProbe>(key: string, now: number): T | undefined {
	const hit = cache.get(key);
	if (!hit) return undefined;
	if (hit.expiresAt <= now) {
		cache.delete(key);
		return undefined;
	}
	return hit.value as T;
}

function remember(key: string, value: LinkProbe | ImageProbe, now: number): void {
	if (value.status === 'skipped') return;
	if (cache.size >= CACHE_MAX_ENTRIES) {
		// Maps iterate in insertion order: the first key is the oldest entry.
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, { expiresAt: now + CACHE_TTL_MS, value });
}

/** Test seam: forget every cached result. */
export function clearProbeCache(): void {
	cache.clear();
}

type Failure = { failure: Exclude<ProbeStatus, 'ok' | 'unverified' | 'skipped'> };

function classifyError(error: unknown): Failure {
	const name = error instanceof Error ? error.name : '';
	return { failure: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable' };
}

/**
 * `method` on `url`, following up to {@link MAX_REDIRECTS} redirects, each hop
 * validated against the SSRF blocklist before it is requested.
 */
async function follow(url: string, method: 'HEAD' | 'GET'): Promise<Response | Failure> {
	let current = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const check = await validatePublicUrl(current);
		if (!check.ok) {
			return { failure: check.code === 'blocked_address' ? 'blocked' : 'unreachable' };
		}
		let response: Response;
		try {
			response = await fetchWithGuardedDispatcher(current, {
				method,
				redirect: 'manual',
				headers: REQUEST_HEADERS,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			return classifyError(error);
		}
		const location = response.headers.get('location');
		if (response.status >= 300 && response.status < 400 && location) {
			await response.body?.cancel().catch(() => undefined);
			try {
				current = new URL(location, current).toString();
			} catch {
				return { failure: 'broken' };
			}
			continue;
		}
		return response;
	}
	return { failure: 'broken' };
}

function statusOf(httpStatus: number): ProbeStatus {
	if (httpStatus >= 200 && httpStatus < 300) return 'ok';
	if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429) return 'unverified';
	return 'broken';
}

/** A final (non-redirect) answer, and which method got it. */
interface Answered {
	response: Response;
	method: 'HEAD' | 'GET';
}

/** HEAD first; GET when HEAD failed or answered anything but 2xx. */
async function headThenGet(url: string): Promise<Answered | Failure> {
	const head = await follow(url, 'HEAD');
	if (head instanceof Response && head.ok) return { response: head, method: 'HEAD' };
	if (head instanceof Response) await head.body?.cancel().catch(() => undefined);
	else if (head.failure === 'blocked') return head;
	const get = await follow(url, 'GET');
	return get instanceof Response ? { response: get, method: 'GET' } : get;
}

async function probeLink(url: string): Promise<LinkProbe> {
	const result = await headThenGet(url);
	if ('failure' in result) return { url, status: result.failure };
	await result.response.body?.cancel().catch(() => undefined);
	return { url, status: statusOf(result.response.status), httpStatus: result.response.status };
}

/** Read at most {@link IMAGE_MEASURE_CAP_BYTES} of a body, counting octets. */
async function measureBody(
	body: ReadableStream<Uint8Array> | null
): Promise<{ bytes: number; atLeast: boolean }> {
	if (!body) return { bytes: 0, atLeast: false };
	const reader = body.getReader();
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return { bytes, atLeast: false };
			bytes += value.byteLength;
			if (bytes > IMAGE_MEASURE_CAP_BYTES) {
				await reader.cancel().catch(() => undefined);
				return { bytes: IMAGE_MEASURE_CAP_BYTES, atLeast: true };
			}
		}
	} catch {
		return { bytes, atLeast: true };
	}
}

function declaredLength(response: Response): number | undefined {
	const raw = response.headers.get('content-length');
	if (!raw) return undefined;
	const length = Number(raw);
	return Number.isFinite(length) && length >= 0 ? length : undefined;
}

async function probeImage(url: string): Promise<ImageProbe> {
	const result = await headThenGet(url);
	if ('failure' in result) return { url, status: result.failure };
	const { response } = result;
	const status = statusOf(response.status);
	const answered = { url, status, httpStatus: response.status };
	const declared = status === 'ok' ? declaredLength(response) : undefined;
	if (status !== 'ok' || declared !== undefined) {
		await response.body?.cancel().catch(() => undefined);
		return declared === undefined ? answered : { ...answered, bytes: declared };
	}
	// No declared length: count the image itself (a HEAD answer has no body).
	const body = result.method === 'HEAD' ? await follow(url, 'GET') : response;
	if (!(body instanceof Response)) return answered;
	const measured = await measureBody(body.body);
	return {
		...answered,
		bytes: measured.bytes,
		...(measured.atLeast ? { bytesAtLeast: true } : {}),
	};
}

async function probeAll<T extends LinkProbe>(
	kind: 'link' | 'image',
	urls: readonly string[],
	probe: (url: string) => Promise<T>,
	deadline: number,
	clock: () => number
): Promise<T[]> {
	const results = await mapWithConcurrency(urls, CONCURRENCY, async (url) => {
		const key = `${kind}:${url}`;
		const hit = cached<T>(key, clock());
		if (hit) return hit;
		if (clock() >= deadline) return { url, status: 'skipped' } as T;
		const value = await probe(url).catch(
			(error: unknown) => ({ url, status: classifyError(error).failure }) as T
		);
		remember(key, value, clock());
		return value;
	});
	return results.map((result, index) => result ?? ({ url: urls[index]!, status: 'skipped' } as T));
}

/** Probe every link and image, inside one shared time budget. */
export async function probeResources(
	links: readonly string[],
	images: readonly string[],
	clock: () => number = Date.now
): Promise<{ links: LinkProbe[]; images: ImageProbe[] }> {
	const deadline = clock() + RUN_BUDGET_MS;
	const [linkResults, imageResults] = await Promise.all([
		probeAll('link', links, probeLink, deadline, clock),
		probeAll('image', images, probeImage, deadline, clock),
	]);
	return { links: linkResults, images: imageResults };
}
