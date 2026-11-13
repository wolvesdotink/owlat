/**
 * Post-first-paint chunk warm-up for the Postbox.
 *
 * The inbox list is what the user sees first, so code the shell loads on demand
 * is not on the critical path for first paint. But once the list has settled,
 * the next thing a user does is often press `/` (search) or `c` (compose), and
 * if that chunk still has to be downloaded, the first interaction stalls.
 *
 * After the list settles we therefore idle-prefetch those chunks with
 * `requestIdleCallback` so the code is already parsed by the time it's needed.
 * This is a pure warm-up: the loaders only pull the module into the bundler's
 * cache, they never mount anything, and every failure is swallowed.
 *
 * Only modules that sit behind a real async boundary belong here: a module the
 * page already imports statically is in its chunk, and importing it again
 * fetches nothing. A test pins every default loader to a lazy mount
 * (`<Lazy…>`) in the app, so the list cannot drift back to no-ops.
 *
 * Deliberately excluded: the Designer-mode `@owlat/email-builder` chunk, which
 * stays lazy (it is large and rarely used) — see PostboxComposer.vue.
 *
 * The loaders and the idle scheduler are injectable so the trigger logic can be
 * unit-tested without touching Vite's real dynamic imports or the DOM.
 */

/** A single chunk loader — typically a `() => import('~/components/...')`. */
export type ChunkLoader = () => Promise<unknown>;

/** Schedules `cb` to run when the main thread is idle. */
export type IdleScheduler = (cb: () => void) => void;

function defaultIdleScheduler(cb: () => void): void {
	if (import.meta.server) return;
	const ric = (
		window as unknown as {
			requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
		}
	).requestIdleCallback;
	if (typeof ric === 'function') ric(cb, { timeout: 2000 });
	else window.setTimeout(cb, 200);
}

let readerChunk: Promise<void> | null = null;

/**
 * Start downloading the thread reader. The Postbox hosts mount it lazily so
 * the list does not wait for the reader's code, which makes the first open pay
 * for the download unless something fetched it before: a route that already
 * names a message, a hovered or focused row, or the idle warm-up below. One
 * request however often it is called; a failed load is forgotten so the next
 * call tries again, and the reader's own lazy mount still surfaces the error.
 */
export function warmPostboxThreadReader(): Promise<void> {
	if (import.meta.server) return Promise.resolve();
	readerChunk ??= import('~/components/postbox/PostboxThreadReader.vue').then(
		() => undefined,
		() => {
			readerChunk = null;
		}
	);
	return readerChunk;
}

/**
 * Default chunks to warm: the command palette (the Postbox `/` search opens
 * it, mounted lazily by the dashboard shell), the compose page Compose
 * navigates to, and the thread reader the next open mounts. NOT the
 * EmailBuilder.
 */
const DEFAULT_LOADERS: ChunkLoader[] = [
	() => import('~/components/AppCommandPalette.vue'),
	() => import('~/pages/dashboard/compose.vue'),
	warmPostboxThreadReader,
];

export function usePostboxChunkWarmup(options?: {
	/** Injected for tests; defaults to the real composer/reader chunk imports. */
	loaders?: ChunkLoader[];
	/** Injected for tests; defaults to requestIdleCallback (setTimeout fallback). */
	schedule?: IdleScheduler;
}) {
	const loaders = options?.loaders ?? DEFAULT_LOADERS;
	const schedule = options?.schedule ?? defaultIdleScheduler;

	let done = false;

	/**
	 * Warm the chunks once. Idempotent — repeated calls (e.g. from a settled
	 * watcher that re-fires) do nothing after the first. No-op during SSR.
	 */
	function warm(): void {
		if (done) return;
		if (import.meta.server) return;
		done = true;
		schedule(() => {
			for (const load of loaders) {
				try {
					void Promise.resolve()
						.then(load)
						.catch(() => {
							// Fail-soft: the real open/compose still loads the chunk.
						});
				} catch {
					// Fail-soft: warm-up must never break the list.
				}
			}
		});
	}

	return { warm };
}
