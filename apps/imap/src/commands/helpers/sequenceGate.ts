/**
 * Per-connection ordering of the commands that use or change the client's
 * sequence view (`SequenceView` in `../types.ts`).
 *
 * The pump starts a pipelined `concurrent` command (a FETCH that sets no \Seen,
 * UID FETCH, NOOP, CHECK, IDLE) without waiting for the ones before it
 * (`connection.ts`), which is what keeps a client's pipelined FETCHes fast;
 * STORE, COPY, MOVE and EXPUNGE still wait for every running command. But
 * a sequence-number command resolves its numbers against the view when it
 * starts and answers with them until it completes, and RFC 3501 §5.5 and
 * §7.4.1 forbid an EXPUNGE while a FETCH, STORE or SEARCH is in progress: it
 * would renumber the messages under it. So every command that touches the view
 * takes a lease here, at dispatch, in the order the client sent it:
 *
 *   - `shared`: sequence-number FETCH, STORE and COPY. Any number of them may
 *     hold it at once (the pump only overlaps FETCHes).
 *   - `sync`: the commands that may announce changes and move the view: NOOP,
 *     CHECK, an IDLE poll, EXPUNGE, MOVE and every UID command. One at a time,
 *     and no command sent after it starts until it releases or downgrades. It
 *     may read the folder at once, but must await {@link SequenceLease.exclusive}
 *     before it announces anything or writes the view, which waits for every
 *     `shared` command sent before it to complete.
 *
 * A UID FETCH / STORE / COPY downgrades to `shared` once its view is current,
 * so pipelined UID FETCHes on a folder that did not change still stream side by
 * side, and a NOOP with nothing to report never waits for a slow FETCH.
 */

import type { CommandDeps } from '../types.js';

export type SequenceAccess = 'shared' | 'sync';

export interface SequenceLease {
	/** Resolves once the lease is granted; nothing may touch the view before. */
	readonly ready: Promise<void>;
	/**
	 * For a granted `sync` lease: resolves once no `shared` lease is held, after
	 * which announcing changes and writing the view is safe. Immediate otherwise.
	 */
	exclusive(): Promise<void>;
	/** Turn a granted `sync` lease into a `shared` one. No-op otherwise. */
	downgrade(): void;
	/** Give the lease back, or withdraw it if not granted yet. Idempotent. */
	release(): void;
}

interface Waiter {
	readonly mode: SequenceAccess;
	readonly grant: () => void;
}

export class SequenceGate {
	private shared = 0;
	private syncHeld = false;
	private readonly queue: Waiter[] = [];
	private sharedGone: Array<() => void> = [];

	/** Ask for a lease. Its place in line is taken now, synchronously. */
	acquire(mode: SequenceAccess): SequenceLease {
		let held: SequenceAccess | 'waiting' | 'released' = 'waiting';
		let resolveReady!: () => void;
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		const waiter: Waiter = {
			mode,
			grant: () => {
				held = mode;
				resolveReady();
			},
		};
		this.queue.push(waiter);
		this.grantWaiting();

		return {
			ready,
			exclusive: () => (held === 'sync' ? this.whenNoShared() : Promise.resolve()),
			downgrade: () => {
				if (held !== 'sync') return;
				held = 'shared';
				this.syncHeld = false;
				this.shared += 1;
				this.grantWaiting();
			},
			release: () => {
				if (held === 'released') return;
				if (held === 'waiting') {
					this.queue.splice(this.queue.indexOf(waiter), 1);
				} else if (held === 'sync') {
					this.syncHeld = false;
				} else {
					this.shared -= 1;
					if (this.shared === 0) this.notifySharedGone();
				}
				held = 'released';
				this.grantWaiting();
			},
		};
	}

	/** Grant from the head of the line until a `sync` lease is held. */
	private grantWaiting(): void {
		while (!this.syncHeld && this.queue.length > 0) {
			const next = this.queue.shift()!;
			if (next.mode === 'sync') this.syncHeld = true;
			else this.shared += 1;
			next.grant();
		}
	}

	private whenNoShared(): Promise<void> {
		if (this.shared === 0) return Promise.resolve();
		return new Promise((resolve) => this.sharedGone.push(resolve));
	}

	private notifySharedGone(): void {
		const waiting = this.sharedGone;
		this.sharedGone = [];
		for (const resolve of waiting) resolve();
	}
}

const UNGATED: SequenceLease = {
	ready: Promise.resolve(),
	exclusive: () => Promise.resolve(),
	downgrade: () => {},
	release: () => {},
};

/**
 * Take a lease on the connection's gate. Call it synchronously from `start`
 * (an `asyncSession` worker runs synchronously up to its first `await`), so the
 * lease is in line in the order the commands arrived. Deps built by hand in
 * unit tests have no gate; their leases are granted at once.
 */
export function holdSequence(deps: CommandDeps, mode: SequenceAccess): SequenceLease {
	return deps.sequenceGate?.acquire(mode) ?? UNGATED;
}
