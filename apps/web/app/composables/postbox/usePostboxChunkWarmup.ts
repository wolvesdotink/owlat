/**
 * Post-first-paint chunk warm-up for the Postbox.
 *
 * The inbox list is what the user sees first, so the composer and the
 * reader-heavy code (sanitize-html, the rich editor) are not on the critical
 * path for first paint. But once the list has settled, the very next thing a
 * user does is press `c` (compose) or `Enter` (open a message) — and if those
 * chunks still need to be downloaded, that first interaction stalls.
 *
 * After the list settles we therefore idle-prefetch those chunks with
 * `requestIdleCallback` so the code is already parsed by the time it's needed.
 * This is a pure warm-up: the loaders only pull the module into the bundler's
 * cache, they never mount anything, and every failure is swallowed.
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
	if (typeof window === 'undefined') return;
	const ric = (
		window as unknown as {
			requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
		}
	).requestIdleCallback;
	if (typeof ric === 'function') ric(cb, { timeout: 2000 });
	else window.setTimeout(cb, 200);
}

/**
 * Default chunks to warm: the composer stack (compose / reply) and the
 * reader-heavy body renderer. NOT the EmailBuilder.
 */
const DEFAULT_LOADERS: ChunkLoader[] = [
	() => import('~/components/postbox/PostboxComposerStack.vue'),
	() => import('~/components/postbox/PostboxComposerPopup.vue'),
	() => import('~/components/postbox/PostboxThreadReader.vue'),
	() => import('~/components/postbox/PostboxMessageBody.vue'),
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
		if (typeof window === 'undefined') return;
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
