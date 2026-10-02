import {
	MAX_COEDIT_OPS_PER_BATCH,
	applyCoeditOps,
	coeditOpKey,
	diffCoeditDocument,
	type CoeditBlock,
	type CoeditDocument,
	type CoeditKey,
	type CoeditOp,
} from '@owlat/shared/coeditOps';

/**
 * Co-editing sync (client half), docs/adr/0071-email-coediting.md.
 *
 * Keeps one editor tab in step with the shared session the server holds. Three
 * states are kept apart, as in a differential sync:
 *
 * - the SHADOW, the last session state the server sent;
 * - the LOCAL state, what the canvas shows (the caller reads it on demand);
 * - the difference between the two, this tab's edits the server has not
 *   applied yet. Nothing else is queued: what to send is always
 *   `diff(shadow, local)`, so a lost or repeated send heals itself.
 *
 * A new server state is merged by re-applying this tab's pending edits on top
 * of it; the operations that turn the local state into the result are the
 * other people's edits, which the caller applies to the canvas (keeping its
 * selection and undo history). One send is in flight at a time, and the next
 * waits until the server state includes the previous one, so an edit is never
 * diffed against a shadow that lacks it.
 *
 * Every outgoing operation names the session version this tab last saw its
 * block or field at, so the server can tell an edit made without seeing
 * someone else's newer write (that write is replaced, and its author told).
 * `pin` holds that version from when the tab started editing a block (it took
 * the edit lease, or opened the inline text editor, whose text reaches the
 * blocks only when it closes).
 *
 * Pure: no Vue, no Convex. `useEmailCoediting` wires it to both.
 */

/** A session state as the server sent it. */
export interface CoeditServerState<B extends CoeditBlock> {
	sessionId: string;
	version: number;
	savedVersion: number;
	baseRevision: number;
	doc: CoeditDocument<B>;
}

/** What a server state means for the canvas. */
export type CoeditReceive<B extends CoeditBlock> =
	/** Show `doc` as it is: the first state, or one the tab chose to adopt. */
	| { kind: 'hydrate'; doc: CoeditDocument<B> }
	/** Apply other people's edits; this tab's unsent edits are kept. */
	| { kind: 'merge'; ops: CoeditOp<B>[] };

/** An operation ready to send, with the version its author last saw its target at. */
export interface CoeditOutgoing<B extends CoeditBlock> {
	op: CoeditOp<B>;
	baseVersion: number;
}

export class CoeditSync<B extends CoeditBlock> {
	private shadow: CoeditServerState<B> | null = null;
	/** Per pending key, the version the tab saw it at before editing it. */
	private readonly pendingBase = new Map<CoeditKey, number>();
	private readonly pins = new Map<CoeditKey, number>();
	private isInFlight = false;
	private sentKeys: CoeditKey[] = [];
	private sentTo: string | null = null;
	/** No send until the shadow reaches this version (it holds the last send). */
	private awaitVersion = 0;
	private adoptNext = false;

	/** The last server state, or null before the first. */
	get server(): CoeditServerState<B> | null {
		return this.shadow;
	}

	get inFlight(): boolean {
		return this.isInFlight;
	}

	/** The server's state changed. See `CoeditReceive`; null means nothing to do. */
	receive(next: CoeditServerState<B>, local: CoeditDocument<B>): CoeditReceive<B> | null {
		const prev = this.shadow;
		const sameSession = prev !== null && prev.sessionId === next.sessionId;
		if (sameSession && next.version < prev.version) return null;
		if (sameSession && next.version === prev.version) {
			// A save or reseed bookkeeping change; the content is the same.
			this.shadow = { ...next, doc: prev.doc };
			return null;
		}
		if (prev === null || this.adoptNext) {
			this.adoptNext = false;
			this.reset(next);
			return { kind: 'hydrate', doc: next.doc };
		}

		// A new session (the old one ended while this tab was away): its base
		// versions mean nothing here. If the old one held unsaved work, this tab
		// is now the only copy of it, so all of it is treated as pending.
		const from = !sameSession && prev.version > prev.savedVersion ? next.doc : prev.doc;
		const pending = diffCoeditDocument(from, local);
		if (!sameSession) this.reset(next);

		const seenAt = sameSession ? prev.version : next.version;
		const pendingKeys = new Set<CoeditKey>();
		for (const op of pending) {
			const key = coeditOpKey(op);
			if (key === null) continue;
			pendingKeys.add(key);
			if (!this.pendingBase.has(key)) this.pendingBase.set(key, seenAt);
		}
		for (const key of this.pendingBase.keys()) {
			if (!pendingKeys.has(key)) this.pendingBase.delete(key);
		}

		const merged = applyCoeditOps(next.doc, pending);
		this.shadow = next;
		return { kind: 'merge', ops: diffCoeditDocument(local, merged) };
	}

	/**
	 * This tab's edits to send now, or null (nothing to send, or a send must
	 * wait). A change bigger than the server takes in one batch goes out in
	 * several: the diff lists deletes, then inserts and moves in target order,
	 * then updates, so every prefix of it is a consistent state to build on.
	 */
	outgoing(local: CoeditDocument<B>): { sessionId: string; ops: CoeditOutgoing<B>[] } | null {
		const shadow = this.shadow;
		if (shadow === null || this.isInFlight || shadow.version < this.awaitVersion) return null;
		const ops = diffCoeditDocument(shadow.doc, local).slice(0, MAX_COEDIT_OPS_PER_BATCH);
		if (ops.length === 0) return null;
		return {
			sessionId: shadow.sessionId,
			ops: ops.map((op) => {
				const key = coeditOpKey(op);
				if (key === null) return { op, baseVersion: shadow.version };
				if (!this.pendingBase.has(key)) this.pendingBase.set(key, shadow.version);
				const base = this.pendingBase.get(key)!;
				return { op, baseVersion: Math.min(base, this.pins.get(key) ?? base) };
			}),
		};
	}

	/** The batch from `outgoing` is on its way. */
	sent(batch: { sessionId: string; ops: readonly CoeditOutgoing<B>[] }): void {
		this.isInFlight = true;
		this.sentTo = batch.sessionId;
		this.sentKeys = batch.ops
			.map(({ op }) => coeditOpKey(op))
			.filter((key): key is CoeditKey => key !== null);
	}

	/** The server applied the batch as `version`. */
	acked(version: number): void {
		const isCurrentSession = this.sentTo === this.shadow?.sessionId;
		this.isInFlight = false;
		this.sentTo = null;
		// A batch that went to a session this tab has since left says nothing
		// about the new one's versions.
		if (!isCurrentSession) {
			this.sentKeys = [];
			return;
		}
		this.awaitVersion = Math.max(this.awaitVersion, version);
		// Further edits to these keys build on this tab's own write.
		for (const key of this.sentKeys) {
			if (this.pendingBase.has(key)) this.pendingBase.set(key, version);
		}
		this.sentKeys = [];
	}

	/** The batch did not land; its edits are still pending and go out with the next. */
	failed(): void {
		this.isInFlight = false;
		this.sentTo = null;
		this.sentKeys = [];
	}

	/** Hold the version `key` was seen at from now until `unpin`. */
	pin(key: CoeditKey): void {
		if (this.shadow && !this.pins.has(key)) this.pins.set(key, this.shadow.version);
	}

	unpin(key: CoeditKey): void {
		this.pins.delete(key);
	}

	/** Drop this tab's unsent edits: the next server state is shown as it is. */
	adoptNextState(): void {
		this.adoptNext = true;
	}

	/** Whether this tab has edits the server has not applied yet. */
	hasUnsent(local: CoeditDocument<B>): boolean {
		if (this.shadow === null) return false;
		return this.isInFlight || diffCoeditDocument(this.shadow.doc, local).length > 0;
	}

	private reset(next: CoeditServerState<B>): void {
		this.shadow = next;
		this.pendingBase.clear();
		for (const key of this.pins.keys()) this.pins.set(key, next.version);
		this.awaitVersion = 0;
	}
}
