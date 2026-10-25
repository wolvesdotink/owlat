import { computed, nextTick, watch, type ComputedRef, type Ref } from 'vue';
import type { DraftLive, DraftReceipt, Fingerprints } from '~/utils/draftSession';
import { useDraftAutosave, type DraftAutosave } from './useDraftAutosave';
import type {
	EmailBuilderHandle,
	EmailEditorBridgeContext,
	EmailEditorConflict,
	EmailEditorSaveBase,
} from './useEmailEditorBridge';
import type { EmailEditorCoedit } from './useEmailEditorCoedit';
import type { EmailEditorConflictChoice } from './useEmailEditorConflict';
import type { UseEditorDirtyTrackingReturn } from './useEditorDirtyTracking';

/**
 * The email editor bridge's autosave half (`useEmailEditorBridge.ts`) for a
 * draft: binds the canvas to its session (`useDraftAutosave.ts`), which owns
 * the draft from then on. The bridge's manual tracker owns it otherwise (a
 * published template); the two hand it over explicitly when the template
 * changes between draft and published.
 *
 * Classic editing: the fields are the canvas refs, the session decides when a
 * server row may replace them, what a save carries and what it covered, and
 * "keep my version" merges onto the latest row the same way the manual
 * tracker does. Live co-editing: the shared session merges everyone's edits;
 * what this tab answers for is its own edits (counted as they are made, not
 * when they are sent 250 ms later). The email is written in the background
 * for them and for others' that nobody else is left to write; an explicit
 * save (Save, the leave prompt, Publish) writes everyone's. The shared
 * session is not the email: until the email holds it, leaving asks.
 */

export interface EmailEditorAutosaveOptions {
	/** Autosave applies: the email is a draft. */
	enabled: () => boolean;
}

export interface EmailEditorAutosaveHost<S> {
	ctx: EmailEditorBridgeContext;
	extraWatch: Ref<unknown>[];
	blocksVersion: Readonly<Ref<number>>;
	builder: () => EmailBuilderHandle | null;
	coediting: EmailEditorCoedit | null;
	/** The loaded row. */
	source: Ref<S>;
	revision?: (row: NonNullable<S>) => number;
	/** Per-surface parse of a row into the canvas refs. */
	initialize: (row: NonNullable<S>) => void;
	canKeepDraft?: (base: NonNullable<S>, latest: NonNullable<S>) => boolean;
	/** The surface's save of the classic draft, built on `base`. */
	save: (base: EmailEditorSaveBase<S>) => Promise<number | void>;
	/**
	 * Live: send this tab's edits and write the session over `revision`;
	 * resolves the revision it stored when known. Rejects unless the session
	 * this tab saw was written to the email.
	 */
	saveSession: (revision: number | undefined) => Promise<number | void>;
	/** Answering a conflict (shared with the manual draft). */
	choice: EmailEditorConflictChoice<S>;
	/** The bridge's manual tracker: it holds the draft while autosave is off. */
	tracker: Pick<
		UseEditorDirtyTrackingReturn<S>,
		'isInitialized' | 'hasChanges' | 'beginSubmit' | 'resume'
	>;
}

export interface EmailEditorAutosave<S> {
	autosave: DraftAutosave;
	/** The row the classic draft is built on (for the manual tracker taking over). */
	baseRow: () => NonNullable<S> | null;
	conflict: ComputedRef<EmailEditorConflict | null>;
	keepMyVersion: () => Promise<void>;
	loadLatestVersion: () => Promise<void>;
	dismissConflict: () => void;
}

const fingerprint = (value: unknown) => JSON.stringify(value) ?? 'undefined';
const identityOf = (row: unknown) =>
	typeof row === 'object' && row !== null && '_id' in row ? (row as { _id: unknown })._id : row;

export function useEmailEditorAutosave<S>(
	opts: EmailEditorAutosaveOptions,
	host: EmailEditorAutosaveHost<S>
): EmailEditorAutosave<S> {
	const { showToast } = useToast();
	const { t } = useI18n();
	const { ctx, extraWatch, coediting } = host;
	const revisionOf = (row: NonNullable<S> | null) =>
		row && host.revision ? host.revision(row) : null;

	/** Who edits the draft now: nobody (published), the classic draft, or the live session. */
	const mode = computed<'off' | 'waiting' | 'classic' | 'live'>(() => {
		if (!opts.enabled()) return 'off';
		const status = coediting?.status.value;
		if (status === 'connecting') return 'waiting';
		return status === 'active' ? 'live' : 'classic';
	});

	// The fields, in the manual tracker's order (its merge works on the same).
	const fields: [string, Ref<unknown>][] = [
		['blocks', ctx.blocks],
		['subject', ctx.subject],
		['name', ctx.name],
		...extraWatch.map((field, i): [string, Ref<unknown>] => [`extra.${i}`, field]),
	];
	const read = (): Fingerprints =>
		Object.fromEntries(fields.map(([name, field]) => [name, fingerprint(field.value)]));

	// The row the classic draft is built on, and the latest one.
	let baseRow: NonNullable<S> | null = null;
	let latestRow: NonNullable<S> | null = null;
	let hydratedId: unknown;
	// A hydration's own writes (and the canvas settling them) are not edits.
	let hydrating = false;

	// What the live session reports. Publish, Save, leaving and the unload
	// warning sample it (`sampled`) right before they decide, so they see a
	// session written (or changed) a moment ago, and an edit typed a moment ago
	// that the change watchers have not counted yet.
	const liveState = (sampled = false): DraftLive | null => {
		if (!coediting || mode.value !== 'live') return null;
		const meta = coediting.meta.value;
		return {
			sessionId: meta?.sessionId ?? null,
			base: meta?.baseRevision ?? null,
			sharedPending: coediting.hasSharedChanges.value,
			unsent: sampled ? coediting.unsentNow() : coediting.hasUnsent.value,
			alone: coediting.isAlone.value,
		};
	};

	const autosave: DraftAutosave = useDraftAutosave({
		enabled: opts.enabled,
		read: () => (mode.value === 'classic' ? read() : {}),
		readLive: () => liveState(true),
		persist: async (flight): Promise<DraftReceipt> => {
			if (autosave.state.value.live) {
				const stored = await host.saveSession(flight.baseRevision ?? undefined);
				return typeof stored === 'number' ? { revision: stored } : {};
			}
			const landed = await host.save({
				source: baseRow,
				revision: flight.baseRevision ?? undefined,
				autosave: true,
			});
			if (typeof landed === 'number') return { revision: landed };
			return flight.baseRevision !== null ? { revision: flight.baseRevision + 1 } : {};
		},
		inline: () => host.builder()?.isInlineEditing === true,
		commitInline: () => host.builder()?.commitInlineEdit?.(),
		hydrate: () => {
			if (mode.value === 'classic' && latestRow) hydrate(latestRow, false);
		},
		reload: () => {
			if (mode.value === 'live') void coediting?.resetShared();
			else if (latestRow) hydrate(latestRow, false);
		},
		dropUnsent: coediting ? () => coediting.dropUnsent() : undefined,
		onRefused: () => showToast(t('shared.draftAutosave.notSavedYet'), 'error'),
	});

	// ── Classic: the row and the canvas ─────────────────────────────────
	const hydrate = (row: NonNullable<S>, fresh: boolean) => {
		hydrating = true;
		host.initialize(row);
		host.builder()?.loadState({
			blocks: ctx.blocks.value,
			name: ctx.name.value,
			subject: ctx.subject.value,
		});
		baseRow = row;
		latestRow = row;
		hydratedId = identityOf(row);
		autosave.dispatch({ type: 'hydrated', revision: revisionOf(row), values: read(), fresh });
		const hydration = autosave.state.value.hydration;
		// The canvas settles what it was given (it may normalize it) after the
		// render: that is still the server's state.
		void nextTick(() => {
			hydrating = false;
			if (mode.value === 'classic')
				autosave.dispatch({ type: 'rebaseline', hydration, values: read() });
		});
	};

	/** Published → draft: take the draft over from the manual tracker, or load it. */
	const takeOver = (row: NonNullable<S>) => {
		const manual = host.tracker;
		if (!manual.isInitialized.value || !manual.hasChanges.value) {
			hydrate(row, false);
			return;
		}
		const held = manual.beginSubmit();
		baseRow = held.base ?? row;
		latestRow = row;
		hydratedId = identityOf(row);
		autosave.dispatch({
			type: 'transfer',
			revision: held.revision ?? null,
			values: read(),
			dirty: true,
		});
	};
	// Draft → published: the manual tracker takes the draft back as the session left it.
	watch(
		opts.enabled,
		(on, was) => {
			if (!on && was) host.tracker.resume(baseRow, autosave.dirty.value);
		},
		{ flush: 'sync' }
	);

	watch(
		[() => host.source.value, mode],
		([row, current], old) => {
			const previous = old?.[1];
			if (current !== 'classic' || !row) return;
			latestRow = row as NonNullable<S>;
			if (
				autosave.state.value.base === null ||
				(previous !== undefined && previous !== 'classic')
			) {
				takeOver(row as NonNullable<S>);
				return;
			}
			if (identityOf(row) !== hydratedId) {
				hydrate(row as NonNullable<S>, true);
				return;
			}
			const revision = revisionOf(row as NonNullable<S>);
			if (revision === null) return;
			autosave.dispatch({ type: 'observed', revision });
			if (revision === autosave.state.value.base?.revision) baseRow = row as NonNullable<S>;
		},
		{ immediate: true }
	);

	const edited = (values: Fingerprints) => {
		if (mode.value === 'classic' && !hydrating) autosave.edit(values);
	};
	watch(host.blocksVersion, () => edited({ blocks: fingerprint(ctx.blocks.value) }));
	watch(ctx.subject, (value) => edited({ subject: fingerprint(value) }));
	watch(ctx.name, (value) => edited({ name: fingerprint(value) }));
	if (extraWatch.length > 0) {
		watch(
			() => extraWatch.map((field) => field.value),
			(values) => edited(Object.fromEntries(values.map((v, i) => [`extra.${i}`, fingerprint(v)]))),
			{ deep: true }
		);
	}

	// ── Live: this tab's own edits, and what the session reports ────────
	if (coediting) {
		watch(coediting.localEdits, () => {
			if (mode.value === 'live') autosave.dispatch({ type: 'live-edit' });
		});
		watch(
			() => liveState(),
			(live) => autosave.dispatch({ type: 'live', live }),
			{
				immediate: true,
				flush: 'sync',
			}
		);
	}

	// ── Conflict ─────────────────────────────────────────────────────────
	const { choice } = host;
	const conflict = computed<EmailEditorConflict | null>(() => {
		const open = autosave.state.value.conflict;
		if (!open?.open) return null;
		return open.mustReload
			? { currentRevision: open.revision, mustReload: true }
			: { currentRevision: open.revision };
	});
	const resolve = async (choose: (mustReload: boolean) => void) => {
		const open = autosave.state.value.conflict;
		if (open) await choice.resolve(open.revision, () => choose(open.mustReload));
	};

	/** Three-way: a field the person left as the base had takes the latest row's value. */
	const mergeOnto = (latest: NonNullable<S>) => {
		const base = autosave.state.value.base?.values ?? {};
		const draft = fields.map(([, field]) => field.value);
		const touched = fields.map(([name, field]) => fingerprint(field.value) !== base[name]);
		const revision = revisionOf(latest) ?? 0;
		baseRow = latest;
		latestRow = latest;
		if (touched.every(Boolean)) {
			autosave.dispatch({ type: 'rebased', revision, base, values: read() });
			return;
		}
		hydrating = true;
		host.initialize(latest);
		const latestValues = read();
		for (const [i, [, field]] of fields.entries()) {
			if (touched[i]) field.value = draft[i];
		}
		host.builder()?.loadState({
			blocks: ctx.blocks.value,
			name: ctx.name.value,
			subject: ctx.subject.value,
		});
		autosave.dispatch({ type: 'rebased', revision, base: latestValues, values: read() });
		void nextTick(() => {
			hydrating = false;
		});
	};

	// "Keep my version": the draft merged onto the latest row (classic) or the
	// session written over it (live), saved naming that row's revision.
	const keepMyVersion = () =>
		resolve((mustReload) => {
			if (mustReload) return;
			const latest = choice.latest();
			if (autosave.state.value.live) {
				const revision = autosave.state.value.conflict?.revision ?? 0;
				autosave.dispatch(
					choice.canKeepLive()
						? { type: 'rebased', revision, base: {}, values: {} }
						: { type: 'rebase-refused' }
				);
				return;
			}
			if (!latest || (baseRow && host.canKeepDraft?.(baseRow, latest) === false)) {
				autosave.dispatch({ type: 'rebase-refused' });
				return;
			}
			mergeOnto(latest);
		});

	return {
		autosave,
		baseRow: () => baseRow,
		conflict,
		keepMyVersion,
		// "Load latest": the draft (live: everyone's unsaved changes) gives way
		// to the server's version. The explicit choice of a conflict, never
		// what leaving the page does.
		loadLatestVersion: () => resolve(() => autosave.dispatch({ type: 'reload' })),
		dismissConflict: () => {
			if (!choice.isResolving.value) autosave.dispatch({ type: 'conflict-dismiss' });
		},
	};
}
