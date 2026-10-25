/**
 * The state, events and effects of a draft editor's session
 * (`draftSession.ts`). Split out for the file-size cap; no logic here.
 */

/** A serialized value per field of the draft. */
export type Fingerprints = Readonly<Record<string, string>>;

/** Whether the editor that wrote a device copy is still open. */
export type DraftLiveness = 'open' | 'closed' | 'unknown';

/** A device copy another editor left under this draft. */
export interface DraftCandidate {
	readonly key: string;
	/** What a conditional delete of exactly this copy compares. */
	readonly token: string;
	readonly liveness: DraftLiveness;
	readonly savedAt: number;
	/** The server state its edits were built on. */
	readonly base: number | null;
	/** It says what the editor showed when the read finished. */
	readonly matches: boolean;
}

/** What a landed save proves about the server state it left. */
export interface DraftReceipt {
	/** The revision the write stored (an email's content revision). */
	readonly revision?: number;
	/** The `updatedAt` before and after the write, from one transaction (a campaign). */
	readonly lineage?: { readonly from: number; readonly to: number };
}

/** A save on its way: the draft frozen when it started. */
export interface DraftFlight {
	readonly id: number;
	readonly epoch: number;
	readonly hydration: number;
	/** The revision the write must still find on the server. */
	readonly baseRevision: number | null;
	readonly values: Fingerprints;
	/** The fields this write carries; only these are covered when it lands. */
	readonly included: readonly string[];
}

/** One write of this editor's device copy. */
export interface DraftCopyWrite {
	readonly token: string;
	/** Monotonic per editor: a later write always has a higher one. */
	readonly seq: number;
	readonly values: Fingerprints;
	readonly base: number | null;
}

export interface DraftOffer {
	readonly request: number;
	readonly candidate: DraftCandidate;
	/** The local revision when it was offered. */
	readonly revision: number;
	/** Edited since the offer: the next Restore replaces that work. */
	readonly confirm: boolean;
}

/** A leave in this window, or an editor opened in a new tab (the page stays). */
export type DraftLeaveKind = 'navigate' | 'open-tab';

export interface DraftLeave {
	readonly id: number;
	readonly phase: 'preparing' | 'choosing' | 'saving';
	readonly destination: string;
	readonly kind: DraftLeaveKind;
	/** The timer bounding the wait for a device copy while preparing. */
	readonly deadline: number | null;
	/** The local revision a Save started from; a newer edit keeps the choice open. */
	readonly revision: number;
}

/** What the live co-editing session reports. */
export interface DraftLive {
	readonly sessionId: string | null;
	/** The email revision the session is built on. */
	readonly base: number | null;
	/** Someone's edits in the session are not written to the email yet. */
	readonly sharedPending: boolean;
	readonly alone: boolean;
}

export interface DraftSessionState {
	readonly writer: string;
	readonly volatile: readonly string[];
	readonly debounceMs: number;
	readonly mirrorMs: number;
	readonly leaveWaitMs: number;
	/** Bumped when the editor moves to another entity or closes. */
	readonly epoch: number;
	readonly closed: boolean;
	/** Autosave applies (a loaded draft). */
	readonly enabled: boolean;
	readonly online: boolean;
	readonly live: DraftLive | null;
	/** Bumped by every hydration: a save started before one covers nothing after it. */
	readonly hydration: number;
	/** The server state the draft is built on, per field. Null until loaded. */
	readonly base: { readonly revision: number | null; readonly values: Fingerprints } | null;
	readonly latest: number | null;
	/** The revision this editor's last acknowledged save stored (its echo). */
	readonly ownRevision: number | null;
	/** Live: "keep my version" names this revision on the next save. */
	readonly keepOver: number | null;
	readonly localRevision: number;
	readonly values: Fingerprints;
	/** Fields whose current value no draft save can store yet (incomplete). */
	readonly deviceOnly: readonly string[];
	/** Text is being typed that the fields do not hold yet. */
	readonly inline: boolean;
	/** Discard: nothing of the current values is saved or kept until the next edit. */
	readonly discarded: boolean;
	readonly flight: DraftFlight | null;
	readonly saveTimer: number | null;
	readonly mirrorTimer: number | null;
	/** The last save's failure, until a save lands. */
	readonly failure: unknown;
	readonly savedAt: number | null;
	readonly conflict: {
		readonly revision: number;
		readonly mustReload: boolean;
		/** Its choice is shown; dismissed, saving still waits until the next edit. */
		readonly open: boolean;
	} | null;
	/** The device keeps writes at all. */
	readonly persistent: boolean;
	/** The copy this editor's key holds, as far as committed writes tell. */
	readonly onDisk: DraftCopyWrite | null;
	/** Writes issued and not settled yet, oldest first. */
	readonly writes: readonly DraftCopyWrite[];
	readonly deviceFailed: boolean;
	readonly seq: number;
	readonly recovery: { readonly request: number; readonly scope: string | null };
	readonly offer: DraftOffer | null;
	/** A restored copy: its source goes once the adopted snapshot is kept elsewhere. */
	readonly adopting: {
		readonly source: DraftCandidate;
		readonly token: string | null;
		readonly values: Fingerprints;
	} | null;
	readonly leave: DraftLeave | null;
	/** A destination a decision let go; the navigation to it passes once. */
	readonly pass: string | null;
	/** A final action (Send, Schedule, Publish) holding background saves. */
	readonly action: { readonly id: number; readonly values: Fingerprints } | null;
	readonly next: number;
}

export type DraftTimerName = 'save' | 'mirror' | 'leave';

export type DraftEvent =
	| { type: 'enabled'; enabled: boolean }
	| { type: 'online'; online: boolean }
	| { type: 'storage'; persistent: boolean }
	| {
			type: 'hydrated';
			revision: number | null;
			values: Fingerprints;
			deviceOnly?: readonly string[];
			/** Another entity than before. */
			fresh: boolean;
	  }
	| {
			type: 'transfer';
			revision: number | null;
			values: Fingerprints;
			deviceOnly?: readonly string[];
			dirty: boolean;
	  }
	| { type: 'rebaseline'; hydration: number; values: Fingerprints }
	| { type: 'observed'; revision: number }
	| { type: 'edit'; values: Fingerprints; deviceOnly?: readonly string[] }
	| { type: 'live-edit' }
	| { type: 'live'; live: DraftLive | null }
	| { type: 'inline'; open: boolean }
	| { type: 'timer'; name: DraftTimerName; id: number }
	| { type: 'save-now' }
	| { type: 'retry' }
	| { type: 'saved'; flight: number; receipt: DraftReceipt; at: number }
	| { type: 'save-failed'; flight: number; error: unknown; conflict: number | null }
	| { type: 'copy-committed'; token: string }
	| { type: 'copy-failed'; token: string }
	| { type: 'recovery-start'; scope: string }
	| { type: 'recovery-read'; request: number; candidates: readonly DraftCandidate[] }
	| { type: 'recovery-restore' }
	| { type: 'recovery-applied'; request: number }
	| { type: 'recovery-discard' }
	| { type: 'leave-requested'; id: number; destination: string; kind: DraftLeaveKind }
	| { type: 'leave-ready'; id: number }
	| { type: 'leave-save'; id: number }
	| { type: 'leave-saved'; id: number; ok: boolean }
	| { type: 'leave-discard'; id: number }
	| { type: 'leave-cancel'; id?: number }
	| { type: 'discard' }
	| { type: 'conflict-dismiss' }
	| { type: 'rebased'; revision: number; base: Fingerprints; values: Fingerprints }
	| { type: 'rebase-refused' }
	| { type: 'reload' }
	| { type: 'action-begin'; id: number }
	| { type: 'action-end'; id: number; ok: boolean; consumed: readonly string[] }
	| { type: 'close' };

/** Why a Save in the leave prompt did not let the page go. */
export type DraftLeaveRefusal = 'unsaved' | 'unkept' | 'schedule';

export type DraftEffect =
	| { type: 'timer'; name: DraftTimerName; id: number; ms: number }
	| { type: 'persist'; flight: DraftFlight }
	| { type: 'write-copy'; write: DraftCopyWrite }
	/** Delete a copy only while it is still one of `tokens`; `key` null is this editor's own. */
	| { type: 'remove-copies'; key: string | null; tokens: readonly string[] }
	| { type: 'read-copies'; request: number; scope: string }
	| { type: 'apply-copy'; request: number; candidate: DraftCandidate }
	/** Follow the latest server row: the draft holds nothing unsaved. */
	| { type: 'hydrate' }
	| { type: 'prepare-leave'; id: number }
	/** A leave request's answer: go, or stay (the prompt shows, or it was superseded). */
	| { type: 'verdict'; id: number; leave: boolean }
	| { type: 'flush-leave'; id: number }
	/** A prompt's choice settled: go to `destination`, or stay. */
	| { type: 'settled'; id: number; destination: string | null; reason?: DraftLeaveRefusal }
	| { type: 'drop-unsent' }
	| { type: 'send-unsent' }
	/** "Load latest": replace the draft with the server's state. */
	| { type: 'reload' };
