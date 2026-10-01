/**
 * An in-memory IMAP server for the remote-state tests: just enough of
 * ImapFlow (RemoteStateClient) — SELECT via the mailbox lock, SEARCH (ALL,
 * UID range, Message-ID header), FETCH by UID list or CHANGEDSINCE — and a
 * tally of what the worker asked for.
 */

import type { RemoteStateClient } from '../remoteState.js';

interface FakeMessage {
	uid: number;
	messageId: string;
	flags: Set<string>;
	modseq: bigint;
}

interface FakeBox {
	uidValidity: bigint;
	messages: FakeMessage[];
}

export interface FakeImapOptions {
	/** CONDSTORE: the mailbox reports HIGHESTMODSEQ and FETCH takes CHANGEDSINCE. */
	condstore?: boolean;
	/** The client keeps the selected mailbox's message count (`exists`). */
	reportsCount?: boolean;
}

export class FakeImap implements RemoteStateClient {
	readonly boxes = new Map<string, FakeBox>();
	private selected: string | null = null;
	private nextUid = 100;
	private modseq = 10n;
	private readonly condstore: boolean;
	private readonly reportsCount: boolean;
	/** What the worker asked for since the last `resetTally()`. */
	tally = { searchAll: [] as string[], searches: 0, fetches: 0, uidsReturned: 0 };
	constructor(boxes: Record<string, string[]>, options: boolean | FakeImapOptions = {}) {
		const opts = typeof options === 'boolean' ? { condstore: options } : options;
		this.condstore = opts.condstore ?? true;
		this.reportsCount = opts.reportsCount ?? true;
		for (const [path, ids] of Object.entries(boxes)) {
			this.boxes.set(path, { uidValidity: 1n, messages: [] });
			for (const id of ids) this.add(path, id);
		}
	}

	get mailbox() {
		const box = this.selected ? this.boxes.get(this.selected) : undefined;
		if (!box) return false as const;
		const highest = box.messages.reduce((m, msg) => (msg.modseq > m ? msg.modseq : m), 1n);
		return {
			uidValidity: box.uidValidity,
			...(this.condstore ? { highestModseq: highest } : {}),
			...(this.reportsCount ? { exists: box.messages.length } : {}),
		};
	}

	resetTally(): void {
		this.tally = { searchAll: [], searches: 0, fetches: 0, uidsReturned: 0 };
	}

	private box(): FakeBox {
		const box = this.selected ? this.boxes.get(this.selected) : undefined;
		if (!box) throw new Error('nothing selected');
		return box;
	}

	add(path: string, messageId: string, flags: string[] = []): void {
		this.boxes.get(path)!.messages.push({
			uid: this.nextUid++,
			messageId,
			flags: new Set(flags),
			modseq: ++this.modseq,
		});
	}

	remove(path: string, messageId: string): void {
		const box = this.boxes.get(path)!;
		box.messages = box.messages.filter((m) => m.messageId !== messageId);
	}

	move(from: string, to: string, messageId: string): void {
		this.remove(from, messageId);
		this.add(to, messageId);
	}

	setFlag(path: string, messageId: string, flag: string, on: boolean): void {
		const msg = this.boxes.get(path)!.messages.find((m) => m.messageId === messageId)!;
		if (on) msg.flags.add(flag);
		else msg.flags.delete(flag);
		msg.modseq = ++this.modseq;
	}

	async getMailboxLock(path: string) {
		if (!this.boxes.has(path)) throw new Error(`NO [NONEXISTENT] ${path}`);
		this.selected = path;
		return { release: () => undefined };
	}

	async search(query: object) {
		this.tally.searches++;
		if ((query as { all?: boolean }).all) this.tally.searchAll.push(this.selected ?? '');
		const matches = (q: Record<string, unknown>, m: FakeMessage): boolean => {
			if (q['all']) return true;
			if (typeof q['uid'] === 'string') {
				const [from, to] = q['uid'].split(':');
				return m.uid >= Number(from) && (to === '*' || m.uid <= Number(to));
			}
			if (Array.isArray(q['or'])) return q['or'].some((sub) => matches(sub, m));
			const header = q['header'] as Record<string, string> | undefined;
			return !!header && m.messageId.includes(header['message-id'] ?? '');
		};
		const box = this.box();
		let hits = box.messages
			.filter((m) => matches(query as Record<string, unknown>, m))
			.map((m) => m.uid);
		// RFC 3501: `n:*` still names the highest UID when n is above it.
		const range = (query as { uid?: string }).uid;
		if (range?.endsWith(':*') && hits.length === 0 && box.messages.length > 0) {
			hits = [Math.max(...box.messages.map((m) => m.uid))];
		}
		this.tally.uidsReturned += hits.length;
		return hits;
	}

	async *fetch(range: string, _query: object, options: { changedSince?: bigint }) {
		this.tally.fetches++;
		const uids = range === '1:*' ? null : new Set(range.split(',').map(Number));
		for (const m of this.box().messages) {
			if (uids && !uids.has(m.uid)) continue;
			if (options.changedSince !== undefined && m.modseq <= options.changedSince) continue;
			this.tally.uidsReturned++;
			yield {
				uid: m.uid,
				flags: new Set(m.flags),
				headers: Buffer.from(`Message-ID: <${m.messageId}>\r\n\r\n`),
				modseq: m.modseq,
			};
		}
	}
}
