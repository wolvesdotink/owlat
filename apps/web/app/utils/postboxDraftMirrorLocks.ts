/**
 * Web Locks for the device mirror: a composer session holds
 * `owlat-mirror:<sessionId>` while it lives, so other tabs do not offer its
 * copies (its text is still on screen there). Offer suppression only: every
 * failure, or a runtime without Web Locks, means "not known to be live", so a
 * copy may be offered, never deleted. Nothing here ever blocks a write.
 */

const LOCK_PREFIX = 'owlat-mirror:';

/** Web Locks, when the runtime has them; any failure means "not known". */
function webLocks(): LockManager | null {
	try {
		return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
	} catch {
		return null;
	}
}

/** Hold this session's lock; returns its release. */
export function holdMirrorSessionLock(sessionId: string): () => void {
	let release: (() => void) | null = null;
	let released = false;
	const locks = webLocks();
	if (locks) {
		try {
			void locks
				.request(`${LOCK_PREFIX}${sessionId}`, { mode: 'exclusive' }, () => {
					if (released) return Promise.resolve();
					return new Promise<void>((resolve) => {
						release = resolve;
					});
				})
				.catch(() => undefined);
		} catch {
			// No lock: this session's copies may be offered elsewhere; harmless.
		}
	}
	return () => {
		released = true;
		release?.();
	};
}

/** The mirror sessions currently alive in any tab of this origin. */
export async function liveMirrorSessions(): Promise<Set<string>> {
	const held = new Set<string>();
	const locks = webLocks();
	if (!locks) return held;
	try {
		const snapshot = await locks.query();
		for (const lock of snapshot.held ?? []) {
			if (lock.name?.startsWith(LOCK_PREFIX)) held.add(lock.name.slice(LOCK_PREFIX.length));
		}
	} catch {
		// Unknown: treat nobody as live (a copy may be offered; never deleted).
	}
	return held;
}
