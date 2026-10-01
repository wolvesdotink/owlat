/**
 * One synced folder's last known contents (remoteState.ts keeps one per
 * tracked folder): UID → Message-ID + flags, plus the two indexes a reconcile
 * needs so that its cost follows what changed rather than the folder's size.
 *
 *   - Message-ID → UIDs, kept up to date on every arrival and removal, so
 *     "which folders hold this message now" costs one look-up per folder
 *     instead of a rebuilt account-wide index.
 *   - UIDs in ascending order, so the newest few (the flag window on a server
 *     without CONDSTORE) are read off the end instead of sorting every UID.
 */

export interface FlagState {
	seen: boolean;
	flagged: boolean;
	answered: boolean;
}

export interface CachedMessage {
	messageId: string | null;
	flags: FlagState;
}

export class FolderView {
	uidValidity: bigint | null = null;
	highestModseq: bigint | null = null;
	/** When (`now` of the reconcile) the whole UID list was last compared; 0 = never. */
	lastCensusAt = 0;
	/**
	 * The next refresh must compare the whole UID list: a known expunge, or a
	 * reconnect after which nothing seen before the gap can be trusted as-is.
	 */
	censusDue = false;
	private readonly byUid = new Map<number, CachedMessage>();
	/** Message-ID → its UID, or UIDs when the folder holds copies. */
	private readonly byMessageId = new Map<string, number | number[]>();
	/** Cached UIDs, ascending once `isAscending`; may still hold removed ones. */
	private ascending: number[] = [];
	private isAscending = true;
	private highestUid = 0;

	get size(): number {
		return this.byUid.size;
	}

	/**
	 * The highest UID this view has taken in since it was last cleared. Every
	 * message the folder holds at or below it is in the view — or left the
	 * folder, which only a census or the message count reveals.
	 */
	get maxUid(): number {
		return this.highestUid;
	}

	get(uid: number): CachedMessage | undefined {
		return this.byUid.get(uid);
	}

	has(uid: number): boolean {
		return this.byUid.has(uid);
	}

	entries(): IterableIterator<[number, CachedMessage]> {
		return this.byUid.entries();
	}

	messages(): IterableIterator<CachedMessage> {
		return this.byUid.values();
	}

	set(uid: number, cached: CachedMessage): void {
		const previous = this.byUid.get(uid);
		if (previous) {
			this.unindex(uid, previous.messageId);
		} else {
			if (uid < this.highestUid) this.isAscending = false;
			else this.highestUid = uid;
			this.ascending.push(uid);
		}
		this.byUid.set(uid, cached);
		if (cached.messageId) this.index(uid, cached.messageId);
	}

	delete(uid: number): CachedMessage | undefined {
		const cached = this.byUid.get(uid);
		if (!cached) return undefined;
		this.byUid.delete(uid);
		this.unindex(uid, cached.messageId);
		return cached;
	}

	clear(): void {
		this.byUid.clear();
		this.byMessageId.clear();
		this.ascending = [];
		this.isAscending = true;
		this.highestUid = 0;
		this.highestModseq = null;
		this.lastCensusAt = 0;
	}

	/** The flags of this folder's copy of `messageId` (the first, if it holds several). */
	flagsOf(messageId: string): FlagState | undefined {
		const uids = this.byMessageId.get(messageId);
		if (uids === undefined) return undefined;
		return this.byUid.get(typeof uids === 'number' ? uids : uids[0]!)?.flags;
	}

	/** Up to `count` of the highest cached UIDs, highest first. */
	newest(count: number): number[] {
		if (!this.isAscending) this.compact();
		const out: number[] = [];
		for (let i = this.ascending.length - 1; i >= 0 && out.length < count; i--) {
			const uid = this.ascending[i]!;
			if (uid !== out.at(-1) && this.byUid.has(uid)) out.push(uid);
		}
		return out;
	}

	/**
	 * Drop removed UIDs from the ordered list (sorting it first if an arrival
	 * came out of order, which only a rebuild sees). A census calls it after
	 * its removals, so the list never outgrows the folder for long.
	 */
	compact(): void {
		if (!this.isAscending) this.ascending.sort((a, b) => a - b);
		let kept = 0;
		let last = -1;
		for (const uid of this.ascending) {
			if (uid !== last && this.byUid.has(uid)) this.ascending[kept++] = uid;
			last = uid;
		}
		this.ascending.length = kept;
		this.isAscending = true;
	}

	private index(uid: number, messageId: string): void {
		const current = this.byMessageId.get(messageId);
		if (current === undefined) this.byMessageId.set(messageId, uid);
		else if (typeof current === 'number') this.byMessageId.set(messageId, [current, uid]);
		else current.push(uid);
	}

	private unindex(uid: number, messageId: string | null): void {
		if (!messageId) return;
		const current = this.byMessageId.get(messageId);
		if (current === undefined) return;
		if (typeof current === 'number') {
			if (current === uid) this.byMessageId.delete(messageId);
			return;
		}
		const rest = current.filter((u) => u !== uid);
		if (rest.length === 0) this.byMessageId.delete(messageId);
		else this.byMessageId.set(messageId, rest.length === 1 ? rest[0]! : rest);
	}
}
