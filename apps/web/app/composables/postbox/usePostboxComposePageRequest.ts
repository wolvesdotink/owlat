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

import { nextTick, ref, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import {
	isBlankMirrorFields,
	mirrorFieldEqual,
	mirrorFieldsEqual,
	type MirrorCopy,
	type MirrorFieldName,
	type MirrorFields,
} from '~/utils/postboxDraftMirror';
import {
	getPostboxDraftMirrorStore,
	mirrorCopyKey,
	provisionalDraftKey,
} from '~/utils/postboxDraftMirrorStore';
import {
	composeRandomId,
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

/** What the page needs of its mounted composer. */
export interface ComposePageComposer {
	flush: () => Promise<SettleOutcome<Id<'mailDrafts'> | null>>;
	parkable: () => ParkableSnapshot;
	mirrorNow: () => Promise<boolean>;
	rescanMirror: () => Promise<void>;
	onCreated: (listener: (id: Id<'mailDrafts'>) => void) => () => void;
}

type Nav = ReturnType<typeof usePostboxComposeNav>;

/** The prefill key each mirrored field travels under in a seed. */
const PREFILL_KEY = {
	toAddresses: 'prefillTo',
	ccAddresses: 'prefillCc',
	bccAddresses: 'prefillBcc',
	subject: 'prefillSubject',
	bodyHtml: 'prefillBodyHtml',
	bodyBlocks: 'prefillBodyBlocks',
	composerMode: 'prefillComposerMode',
	followUpRemindAt: 'prefillFollowUpRemindAt',
} as const satisfies Record<MirrorFieldName, keyof ComposeSpec>;

/** `seed` with a parked snapshot's present fields laid over it. */
export function seedWithParked(seed: ComposeSpec, source: RecoverySource): ComposeSpec {
	const next: Record<string, unknown> = { ...seed };
	for (const name of source.present) {
		if (name === 'bodyBlocks') {
			if (source.fields.bodyBlocks === null) continue;
			try {
				next[PREFILL_KEY.bodyBlocks] = JSON.parse(source.fields.bodyBlocks) as unknown[];
			} catch {
				// Malformed blocks: the body HTML still carries the text.
			}
			continue;
		}
		const value = source.fields[name];
		next[PREFILL_KEY[name]] = Array.isArray(value) ? [...value] : value;
	}
	return next as unknown as ComposeSpec;
}

/**
 * The composer's seed with the request's rowless snapshots laid over it,
 * oldest first (the newest wins), and those snapshots. Only for a request with
 * no row yet: the record keeps them as recovery sources until something else
 * holds the text, so a nonce that turns out to name an existing row (whose
 * text may be newer) offers them instead of having them imposed.
 */
export function foldRowless(
	seed: ComposeSpec,
	request: ComposeRequest
): { seed: ComposeSpec; folded: RecoverySource[] } {
	const parked = [...request.sources, ...(request.current ? [request.current] : [])];
	const folded = parked.filter((source) => source.rowless).sort((a, b) => a.parkedAt - b.parkedAt);
	let next = seed;
	for (const source of folded) next = seedWithParked(next, source);
	return { seed: next, folded };
}

/** The seed the composer opens with. */
export function composerSeedOf(request: ComposeRequest): ComposeSpec {
	// A request with a row must not run creation-time work again on a remount.
	const base = request.draftId ? withoutCreationKeys(request.seed) : request.seed;
	return {
		...base,
		mailboxId: request.mailboxId,
		requestNonce: request.requestNonce,
		...(request.draftId ? { draftId: request.draftId } : {}),
	};
}

/** Every present field of `source` equals the row. */
function equalsRow(source: Pick<RecoverySource, 'fields' | 'present'>, row: MirrorFields): boolean {
	return source.present.every((name) => mirrorFieldEqual(name, source.fields, row));
}

/** The record after a leave with `snap` on screen. */
export function parkLeave(
	request: ComposeRequest,
	snap: ParkableSnapshot,
	mountId: string,
	now: number,
	/** Snapshots this mount merged into the editor: a whole-editor park holds them. */
	merged: readonly string[] = []
): ComposeRequest {
	const sources = snap.ready
		? request.sources.filter((source) => !merged.includes(source.id))
		: [...request.sources];
	// An earlier mount's unresolved snapshot is kept on its own; this mount's
	// own earlier park (a `pagehide` before a bfcache return) is replaced.
	if (
		request.current &&
		request.current.mountId !== mountId &&
		!(snap.ready && merged.includes(request.current.id))
	) {
		sources.push(request.current);
	}
	const saved = snap.base !== null && equalsRow(snap, snap.base);
	const empty =
		snap.present.length === 0 ||
		(snap.draftId === null && isBlankMirrorFields(snap.fields) && !seedCarriesText(request.seed));
	const current: RecoverySource | undefined =
		saved || empty
			? undefined
			: {
					id: composeRandomId(),
					fields: snap.fields,
					present: snap.present,
					base: snap.base,
					rowless: snap.draftId === null,
					mountId,
					parkedAt: now,
				};
	// Once the whole editor is parked (or saved), the open's text is in it.
	const seed = snap.ready && (current || saved) ? withoutSeedText(request.seed) : request.seed;
	const draftId = request.draftId ?? snap.draftId ?? undefined;
	return { ...request, seed, ...(draftId ? { draftId } : {}), current, sources };
}

/** The record without the named sources. */
function withoutSources(request: ComposeRequest, ids: readonly string[]): ComposeRequest {
	if (ids.length === 0) return request;
	return {
		...request,
		current: request.current && ids.includes(request.current.id) ? undefined : request.current,
		sources: request.sources.filter((source) => !ids.includes(source.id)),
	};
}

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
		merged = sources;
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
			} else {
				toImport.push(source);
			}
		}
		change((current) => withoutSources(current, resolved));
		const draftId = composer.value?.parkable().draftId ?? request.draftId;
		if (draftId) {
			for (const source of toImport) void importAsCopy(source, row, draftId, request);
		}
		// The merged text: held once the mirror has written it (ready by then).
		if (merged.length > 0) void nextTick(() => settleMerged());
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
		const existing = await store.list(ns, String(draftId));
		if (!existing.some((record) => mirrorFieldsEqual(record.copy.fields, fields))) {
			const copy: MirrorCopy = {
				v: 2,
				fields,
				base: parked.base,
				savedAt: parked.parkedAt,
				draftId: String(draftId),
				inReplyTo: request.seed?.inReplyToMessageId
					? String(request.seed.inReplyToMessageId)
					: null,
			};
			const key = mirrorCopyKey(ns, String(draftId), `parked-${source.id}`, 'live');
			// Not stored (no device storage): the record keeps it for the next open.
			if (!(await store.write(key, copy))) return;
		}
		change((current) => withoutSources(current, [source.id]));
		void composer.value?.rescanMirror();
	}

	/**
	 * Drop merged snapshots once something else holds them: the device mirror
	 * wrote the editor, or the latest row already equals them. Runs a tick after
	 * the merge and again on every save, so neither a failed device write nor a
	 * composer that was not mounted yet leaves them behind for good.
	 */
	async function settleMerged() {
		const mounted = composer.value;
		if (merged.length === 0 || !mounted) return;
		// Rowless text is held by the mirror only once the row is known not to
		// be an older one; until then a save or the row itself decides.
		if (!merged.some((source) => source.rowless) && (await mounted.mirrorNow())) {
			dropMerged();
			return;
		}
		const row = mounted.parkable().base;
		if (row && merged.every((source) => equalsRow(source, row))) dropMerged();
	}

	function dropMerged() {
		if (merged.length === 0) return;
		const ids = merged.map((source) => source.id);
		merged = [];
		change((request) => withoutSources(request, ids));
	}

	/**
	 * A save acknowledged what the editor holds. Simple-mode saves leave the
	 * stored blocks alone, so a merged snapshot whose blocks differ from the row
	 * is not held by one.
	 */
	function savedAcknowledged(draftId: Id<'mailDrafts'>) {
		const snap = composer.value?.parkable();
		change((request) => ({ ...request, draftId, seed: withoutSeedText(request.seed) }));
		if (
			merged.every(
				(source) =>
					snap?.fields.composerMode === 'full' ||
					!source.present.includes('bodyBlocks') ||
					source.fields.bodyBlocks === null ||
					source.fields.bodyBlocks === source.base?.bodyBlocks
			)
		) {
			dropMerged();
		}
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
		const mergedIds = merged.map((source) => source.id);
		change((request) => parkLeave(request, snap, own.mountId, Date.now(), mergedIds));
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
