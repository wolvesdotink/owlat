/**
 * The state, events and effects of a draft editor's session
 * (`draftSession.ts`). Split out for the file-size cap; no logic here.
 */

/** A serialized value per field of the draft. */
export type Fingerprints = Readonly<Record<string, string>>;

/** What a landed save proves about the server state it left. */
export interface DraftReceipt {
	/** The revision the write stored (the email's content revision). */
	readonly revision?: number;
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

export interface DraftLeave {
	readonly id: number;
	readonly phase: 'preparing' | 'choosing' | 'saving';
	readonly destination: string;
	/** The local revision a Save started from; a newer edit keeps the choice open. */
	readonly revision: number;
}

/** What the live co-editing session reports. */
export interface DraftLive {
	readonly sessionId: string | null;
	/** The email revision the session is built on. */
	readonly base: number | null;
	/** The session holds edits (anyone's) that are not written to the email yet. */
	readonly sharedPending: boolean;
	/** This tab has edits the session has not taken yet. */
	readonly unsent: boolean;
	readonly alone: boolean;
}

export interface DraftSessionState {
	readonly debounceMs: number;
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
	/** Text is being typed that the fields do not hold yet. */
	readonly inline: boolean;
	/** Discard: nothing of the current values is saved until the next edit. */
	readonly discarded: boolean;
	readonly flight: DraftFlight | null;
	readonly saveTimer: number | null;
	/** The last save's failure, until a save lands. */
	readonly failure: unknown;
	readonly savedAt: number | null;
	readonly conflict: {
		readonly revision: number;
		readonly mustReload: boolean;
		/** Its choice is shown; dismissed, saving still waits until the next edit. */
		readonly open: boolean;
	} | null;
	readonly leave: DraftLeave | null;
	/** A destination a decision let go; the navigation to it passes once. */
	readonly pass: string | null;
	/** A final action (Publish) holding background saves. */
	readonly action: { readonly id: number } | null;
	readonly next: number;
}

export type DraftEvent =
	| { type: 'enabled'; enabled: boolean }
	| { type: 'online'; online: boolean }
	| {
			type: 'hydrated';
			revision: number | null;
			values: Fingerprints;
			/** Another entity than before. */
			fresh: boolean;
	  }
	| { type: 'transfer'; revision: number | null; values: Fingerprints; dirty: boolean }
	| { type: 'rebaseline'; hydration: number; values: Fingerprints }
	| { type: 'observed'; revision: number }
	| { type: 'edit'; values: Fingerprints }
	| { type: 'live-edit' }
	| { type: 'live'; live: DraftLive | null }
	| { type: 'inline'; open: boolean }
	| { type: 'timer'; id: number }
	/** An explicit save (Save, the leave prompt, Publish): saves what is shown. */
	| { type: 'save-now' }
	| { type: 'retry' }
	| { type: 'saved'; flight: number; receipt: DraftReceipt; at: number }
	| { type: 'save-failed'; flight: number; error: unknown; conflict: number | null }
	| { type: 'leave-requested'; id: number; destination: string }
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
	| { type: 'action-end'; id: number }
	| { type: 'close' };

export type DraftEffect =
	| { type: 'timer'; id: number; ms: number }
	| { type: 'persist'; flight: DraftFlight }
	/** Follow the latest server row: the draft holds nothing unsaved. */
	| { type: 'hydrate' }
	| { type: 'prepare-leave'; id: number }
	/** A leave request's answer: go, or stay (the prompt shows, or it was superseded). */
	| { type: 'verdict'; id: number; leave: boolean }
	| { type: 'flush-leave'; id: number }
	/** A prompt's choice settled: go to `destination`, or stay (`refused`: its Save did not cover the draft). */
	| { type: 'settled'; id: number; destination: string | null; refused?: boolean }
	| { type: 'drop-unsent' }
	/** "Load latest": replace the draft with the server's state. */
	| { type: 'reload' };
