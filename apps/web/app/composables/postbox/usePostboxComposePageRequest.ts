/**
 * The compose page's side of its compose request (`usePostboxComposeNav`):
 * which request the page shows, the seed its composer opens with, and what
 * happens to unsaved text when the page is left. Kept out of the page so every
 * rule here is testable without mounting it.
 *
 * LEAVING NEVER DROPS THE ONLY COPY (G4). Every unfinished leave (not sent, not
 * discarded) parks the editor's latest fields in the request record,
 * synchronously, so nothing depends on a save or a device write still running
 * after the page is gone:
 *
 *   - all fields once the composer is ready; before that only the fields the
 *     seed or the person set (the rest are empty stand-ins, never real text);
 *   - with `base`, the row as last observed, so a return can tell whether the
 *     draft moved on since;
 *   - nothing when the text equals that row (it is saved).
 *
 * A RETURN RESOLVES EACH PARKED SNAPSHOT ON ITS OWN:
 *
 *   - parked before the composition had a row: merged back into the seed (its
 *     fields win over the row the request nonce leads back to, as an open's do);
 *   - otherwise, once the row has loaded and before the composer is ready
 *     (nothing has been autosaved over the row yet):
 *       · equal to the row: dropped, it is saved;
 *       · the row is still the one it was parked against and nothing it holds
 *         was edited again in this mount: merged into the editor, and dropped
 *         once the device mirror or the server holds the result;
 *       · anything else: stored as a device copy for this draft, which the
 *         mirror offers back with "Restore unsaved changes" (asking first, as
 *         the row may hold newer text), and dropped once that copy committed.
 *
 * Every record write after the claim is fenced by this mount's id: a page that
 * has gone keeps its late callbacks (a row created after the leave still binds
 * to the request), but never overwrites what a newer mount of it wrote.
 */

import { ref, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import {
	MIRROR_FIELD_NAMES,
	mirrorFieldEqual,
	mirrorFieldsEqual,
	type MirrorCopy,
	type MirrorFields,
} from '~/utils/postboxDraftMirror';
import {
	getPostboxDraftMirrorStore,
	mirrorCopyKey,
	provisionalDraftKey,
} from '~/utils/postboxDraftMirrorStore';
import {
	type usePostboxComposeNav,
	seedCarriesText,
	withoutCreationKeys,
	withoutSeedText,
	type ComposeRequest,
	type ComposeSpec,
	type RecoverySource,
} from './usePostboxComposeNav';
import type { BeforeReadyContext, ParkableSnapshot } from './usePostboxComposeRow';
import type { SettleOutcome } from './usePostboxComposeAutosave';
import {
	composerSeedOf,
	equalsRow,
	foldRowless,
	parkLeave,
	sourceFromSeed,
	withoutSources,
} from './postboxComposeParking';

export {
	composerSeedOf,
	foldRowless,
	parkLeave,
	seedWithParked,
	sourceFromSeed,
} from './postboxComposeParking';

/** What the page needs of its mounted composer. */
export interface ComposePageComposer {
	flush: () => Promise<SettleOutcome<Id<'mailDrafts'> | null>>;
	parkable: () => ParkableSnapshot;
	rescanMirror: () => Promise<void>;
	onCreated: (listener: (id: Id<'mailDrafts'>) => void) => () => void;
}

type Nav = ReturnType<typeof usePostboxComposeNav>;

export type ComposePageState =
	| { status: 'pending' }
	| { status: 'expired' }
	| { status: 'ready'; key: string; mountId: string };

export function usePostboxComposePageRequest(options: {
	nav: Nav;
	composer: Readonly<Ref<ComposePageComposer | null>>;
}) {
	const { nav, composer } = options;
	const state = ref<ComposePageState>({ status: 'pending' });
	const seed = ref<ComposeSpec | null>(null);
	let finished = false;
	// Merged snapshots waiting for the mirror or a save to hold the result.
	let merged: RecoverySource[] = [];

	function owned(): { key: string; mountId: string } | null {
		return state.value.status === 'ready' ? state.value : null;
	}

	function change(fn: (request: ComposeRequest) => ComposeRequest | null): boolean {
		const own = owned();
		return own ? nav.update(own.key, own.mountId, fn) : false;
	}

	/** Show request `key`; a draft named in the URL adopts an unknown key. */
	function openRequest(
		key: string,
		urlDraft?: { mailboxId: Id<'mailboxes'>; draftId: Id<'mailDrafts'> }
	) {
		if (!nav.read(key)) {
			// An unknown key without a row never gets a fresh nonce: that could
			// create a second draft for one composition.
			if (!urlDraft) {
				state.value = { status: 'expired' };
				return;
			}
			nav.adoptDraft(key, urlDraft.mailboxId, urlDraft.draftId);
		}
		const mountId = nav.claim(key);
		if (!mountId) {
			state.value = { status: 'expired' };
			return;
		}
		state.value = { status: 'ready', key, mountId };
		change((current) => {
			const fromSeed = current.seedOpened ? sourceFromSeed(current) : null;
			return fromSeed
				? {
						...current,
						seed: withoutSeedText(current.seed),
						sources: [...current.sources, fromSeed],
					}
				: { ...current, seedOpened: true };
		});
		const request = nav.read(key);
		if (!request) {
			state.value = { status: 'expired' };
			return;
		}
		if (request.draftId) {
			// Rowless snapshots of a request with a row go through `beforeReady`.
			seed.value = composerSeedOf(request);
			return;
		}
		const { seed: folded, folded: sources } = foldRowless(composerSeedOf(request), request);
		seed.value = folded;
		// Only snapshots whose text shows: a field a newer one overrode hides it,
		// and a hidden snapshot is not resolved by what the editor holds.
		merged = sources.filter((source, i) =>
			source.present.every(
				(name) =>
					!sources
						.slice(i + 1)
						.some(
							(newer) =>
								newer.present.includes(name) && !mirrorFieldEqual(name, newer.fields, source.fields)
						)
			)
		);
	}

	let bound = false;
	/** Bind the composer once it is mounted: its row joins the request. */
	function bindComposer(mounted: ComposePageComposer) {
		if (bound) return;
		bound = true;
		// Runs after unmount too (fenced), so a row created after a leave is bound.
		mounted.onCreated((id) => {
			change((request) => ({ ...request, draftId: id, seed: withoutCreationKeys(request.seed) }));
		});
	}

	/** The composer's `beforeReady`: resolve snapshots parked against a row. */
	function beforeReady(row: MirrorFields, context: BeforeReadyContext) {
		const own = owned();
		const request = own ? nav.read(own.key) : null;
		if (!own || !request || request.mountId !== own.mountId) return;
		// Text folded in before the row was known was replaced by the row's
		// (the seed does not win over an existing row): judged again below.
		merged = [];
		const parked = [
			...(request.current ? [request.current] : []),
			...[...request.sources].reverse(),
		];
		if (parked.length === 0) return;

		const resolved: string[] = [];
		const toImport: RecoverySource[] = [];
		for (const source of parked) {
			if (equalsRow(source, row)) {
				resolved.push(source.id);
			} else if (
				merged.length === 0 &&
				source.base !== null &&
				mirrorFieldsEqual(source.base, row) &&
				context.merge(source.fields, source.present)
			) {
				merged = [source];
				// Exactly the merged text, saved ahead of any later edit.
				void context.persist().then((saved) => {
					if (saved.ok) dropMerged([source.id]);
				});
			} else {
				toImport.push(source);
			}
		}
		change((current) => withoutSources(current, resolved));
		const draftId = composer.value?.parkable().draftId ?? request.draftId;
		if (draftId) {
			for (const source of toImport) void importAsCopy(source, row, draftId, request);
		}
	}

	async function importAsCopy(
		source: RecoverySource,
		row: MirrorFields,
		draftId: Id<'mailDrafts'>,
		request: ComposeRequest
	) {
		const store = getPostboxDraftMirrorStore();
		const ns = String(request.mailboxId);
		// Plain copies: the record comes from session state (reactive), and
		// IndexedDB cannot clone a proxy.
		const parked = JSON.parse(JSON.stringify(source)) as RecoverySource;
		// Placeholders take the row's values: only present fields are offered.
		const fields = JSON.parse(JSON.stringify(row)) as MirrorFields;
		for (const name of parked.present) {
			(fields as unknown as Record<string, unknown>)[name] = parked.fields[name];
		}
		// Always its own immutable slot: another session's copy of the same text
		// can be replaced at any moment, so it does not hold this one (the scan
		// offers identical copies once).
		const copy: MirrorCopy = {
			v: 2,
			fields,
			base: parked.base,
			savedAt: parked.parkedAt,
			draftId: String(draftId),
			inReplyTo: request.seed?.inReplyToMessageId ? String(request.seed.inReplyToMessageId) : null,
			// Partial (parked before its row loaded): only the typed fields are
			// real; the rest only show the row as it was, never to be restored.
			...(parked.present.length < MIRROR_FIELD_NAMES.length ? { present: parked.present } : {}),
		};
		const key = mirrorCopyKey(ns, String(draftId), `parked-${source.id}`, 'live');
		// Not stored (no device storage): the record keeps it for the next open.
		if (!(await store.write(key, copy))) return;
		change((current) => withoutSources(current, [source.id]));
		void composer.value?.rescanMirror();
	}

	/**
	 * Drop merged snapshots the latest row already equals (runs on every save).
	 * Anything else stays until its own save is acknowledged: the editor moving
	 * on past it, or the mirror holding the editor, does not hold it.
	 */
	function settleMerged() {
		const row = composer.value?.parkable().base ?? null;
		if (!row) return;
		dropMerged(merged.filter((source) => equalsRow(source, row)).map((source) => source.id));
	}

	function dropMerged(ids: readonly string[]) {
		if (ids.length === 0) return;
		merged = merged.filter((source) => !ids.includes(source.id));
		change((request) => withoutSources(request, ids));
	}

	/**
	 * A flush succeeded. That proves the row exists, not that it holds the
	 * editor's text (a scheduled or pending row is never written), so the open's
	 * text and merged snapshots are dropped only when the latest observed row
	 * equals what they carry.
	 */
	function savedAcknowledged(draftId: Id<'mailDrafts'>) {
		const snap = composer.value?.parkable();
		const row = snap?.base ?? null;
		const editorSaved = !!snap && row !== null && mirrorFieldsEqual(snap.fields, row);
		change((request) => ({
			...request,
			draftId,
			seed: editorSaved ? withoutSeedText(request.seed) : request.seed,
		}));
		settleMerged();
	}

	/**
	 * Whether the request still holds text the server may not have: the open's
	 * text, a composition with no row yet, or parked text merged into the
	 * editor that no save has acknowledged.
	 */
	function carriesText(): boolean {
		const own = owned();
		const request = own ? nav.read(own.key) : null;
		return !!request && (seedCarriesText(request.seed) || !request.draftId || merged.length > 0);
	}

	/** Park what is on screen (every unfinished leave, and `pagehide`). */
	function parkOnLeave() {
		const own = owned();
		const mounted = composer.value;
		if (finished || !own || !mounted) return;
		const snap = mounted.parkable();
		change((request) => parkLeave(request, snap, own.mountId, Date.now()));
	}

	/**
	 * Sent or discarded: the composition is over. That resolves what was on
	 * screen (this mount's own snapshots and what it merged), not snapshots
	 * parked by earlier mounts that were never shown (their device copy could
	 * not be stored): those move to device copies offered to the next new
	 * message, and the record stays until each of them is stored.
	 */
	function finish() {
		finished = true;
		const own = owned();
		const request = own ? nav.read(own.key) : null;
		if (!own || !request) return;
		const used = new Set(merged.map((source) => source.id));
		const unseen = [...request.sources, ...(request.current ? [request.current] : [])].filter(
			(source) => source.mountId !== own.mountId && !used.has(source.id)
		);
		if (unseen.length === 0) {
			nav.forget(own.key, own.mountId);
			return;
		}
		change((current) => ({ ...withoutSources(current, [...used]), seed: undefined }));
		void keepUnseen(own, request, unseen);
	}

	async function keepUnseen(
		own: { key: string; mountId: string },
		request: ComposeRequest,
		unseen: RecoverySource[]
	) {
		const store = getPostboxDraftMirrorStore();
		const ns = String(request.mailboxId);
		const inReplyTo = request.seed?.inReplyToMessageId
			? String(request.seed.inReplyToMessageId)
			: null;
		let allKept = true;
		for (const source of unseen) {
			const parked = JSON.parse(JSON.stringify(source)) as RecoverySource;
			const sessionId = `parked-${parked.id}`;
			const copy: MirrorCopy = {
				v: 2,
				fields: parked.fields,
				base: null,
				savedAt: parked.parkedAt,
				draftId: null,
				inReplyTo,
				// Only the supplied fields are real (the rest were never loaded).
				...(parked.present.length < MIRROR_FIELD_NAMES.length ? { present: parked.present } : {}),
			};
			const key = mirrorCopyKey(ns, provisionalDraftKey(sessionId), sessionId, 'live');
			if (await store.write(key, copy))
				nav.update(own.key, own.mountId, (r) => withoutSources(r, [source.id]));
			else allKept = false;
		}
		if (allKept) nav.forget(own.key, own.mountId);
	}

	return {
		state,
		seed,
		openRequest,
		bindComposer,
		beforeReady,
		settleMerged,
		savedAcknowledged,
		carriesText,
		parkOnLeave,
		finish,
		isFinished: () => finished,
	};
}
