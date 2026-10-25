import { computed, nextTick, watch, type ComputedRef, type Ref } from 'vue';
import type { EditorBlock } from '@owlat/email-builder';
import { canonicalJson } from '@owlat/shared/canonicalJson';
import type { DraftReceipt, Fingerprints } from '~/utils/draftSession';
import { editorDraftScope, type EditorDraftKind } from '~/utils/editorDraftStore';
import { useDraftAutosave, type DraftAutosave } from './useDraftAutosave';
import type { DraftRecovery } from './useDraftRecovery';
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
 * when they are sent 250 ms later), and the email is written for them, for
 * others' that nobody else is left to write, and for everyone's before Publish.
 */

/** What the canvas holds, as the device keeps it. */
export interface EmailDraftSnapshot {
	name: string;
	subject: string;
	blocks: EditorBlock[];
	/** The surface's own dirty-tracked values, in `extraWatch` order. */
	extra: unknown[];
}

export interface EmailEditorAutosaveOptions {
	/** Autosave applies: the email is a draft. */
	enabled: () => boolean;
	/** Which device copy this email's draft is. */
	kind: EditorDraftKind;
	id: () => string | null;
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
	/** Live: send this tab's edits and write the session over `revision`. */
	saveSession: (revision: number | undefined) => Promise<void>;
	/** Answering a conflict (shared with the manual draft). */
	choice: EmailEditorConflictChoice<S>;
	/** The bridge's manual tracker: it holds the draft while autosave is off. */
	tracker: Pick<
		UseEditorDirtyTrackingReturn<S>,
		'isInitialized' | 'hasChanges' | 'beginSubmit' | 'resume'
	>;
}

export interface EmailEditorAutosave<S> {
	autosave: DraftAutosave<EmailDraftSnapshot>;
	recovery: DraftRecovery<EmailDraftSnapshot>;
	/** The row the classic draft is built on (for the manual tracker taking over). */
	baseRow: () => NonNullable<S> | null;
	conflict: ComputedRef<EmailEditorConflict | null>;
	keepMyVersion: () => Promise<void>;
	loadLatestVersion: () => Promise<void>;
	dismissConflict: () => void;
}

const isSnapshot = (data: unknown): data is EmailDraftSnapshot => {
	if (typeof data !== 'object' || data === null) return false;
	const draft = data as Partial<EmailDraftSnapshot>;
	return (
		typeof draft.name === 'string' &&
		typeof draft.subject === 'string' &&
		Array.isArray(draft.blocks) &&
		Array.isArray(draft.extra)
	);
};

const fingerprint = (value: unknown) => JSON.stringify(value) ?? 'undefined';
const identityOf = (row: unknown) =>
	typeof row === 'object' && row !== null && '_id' in row ? (row as { _id: unknown })._id : row;

export function useEmailEditorAutosave<S>(
	opts: EmailEditorAutosaveOptions,
	host: EmailEditorAutosaveHost<S>
): EmailEditorAutosave<S> {
	const { user, activeOrganizationId } = useAuth();
	const { showToast } = useToast();
	const { t } = useI18n();
	const { ctx, extraWatch, coediting } = host;
	const revisionOf = (row: NonNullable<S> | null) =>
		row && host.revision ? host.revision(row) : null;

	const scope = computed(() => {
		const id = opts.id();
		const userId = user.value?.id;
		const organizationId = activeOrganizationId.value;
		return id && userId && organizationId
			? editorDraftScope({ userId, organizationId, kind: opts.kind, id })
			: null;
	});

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

	const snapshot = (): EmailDraftSnapshot => ({
		name: ctx.name.value,
		subject: ctx.subject.value,
		blocks: ctx.blocks.value,
		extra: extraWatch.map((field) => field.value),
	});

	// The row the classic draft is built on, and the latest one.
	let baseRow: NonNullable<S> | null = null;
	let latestRow: NonNullable<S> | null = null;
	let hydratedId: unknown;
	// A hydration's own writes (and the canvas settling them) are not edits.
	let hydrating = false;

	const notify = (key: string) => showToast(t(key), 'error');

	const autosave: DraftAutosave<EmailDraftSnapshot> = useDraftAutosave<EmailDraftSnapshot>({
		enabled: opts.enabled,
		scope: () => scope.value,
		read: () => ({ values: mode.value === 'classic' ? read() : {} }),
		snapshot,
		persist: async (flight): Promise<DraftReceipt> => {
			if (autosave.state.value.live) {
				await host.saveSession(flight.baseRevision ?? undefined);
				return {};
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
		accept: isSnapshot,
		matches: (data) => canonicalJson(data) === canonicalJson(snapshot()),
		apply: (data) => {
			ctx.name.value = data.name;
			ctx.subject.value = data.subject;
			ctx.blocks.value = data.blocks;
			for (const [i, field] of extraWatch.entries()) {
				if (i < data.extra.length) field.value = data.extra[i];
			}
			host.builder()?.loadState({ blocks: data.blocks, name: data.name, subject: data.subject });
		},
		hydrate: () => {
			if (mode.value === 'classic' && latestRow) hydrate(latestRow, false);
		},
		reload: () => {
			if (mode.value === 'live') void coediting?.resetShared();
			else if (latestRow) hydrate(latestRow, false);
		},
		live: coediting
			? { sendUnsent: () => coediting.sendUnsent(), dropUnsent: () => coediting.dropUnsent() }
			: undefined,
		ready: () => mode.value === 'classic' || mode.value === 'live',
		onRefused: (reason) =>
			notify(
				reason === 'unkept'
					? 'shared.draftAutosave.unkeptDetail'
					: 'shared.draftAutosave.notSavedYet'
			),
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
			() => [
				mode.value,
				coediting.meta.value,
				coediting.isAlone.value,
				coediting.hasSharedChanges.value,
			],
			() => {
				const meta = coediting.meta.value;
				autosave.dispatch({
					type: 'live',
					live:
						mode.value === 'live'
							? {
									sessionId: meta?.sessionId ?? null,
									base: meta?.baseRevision ?? null,
									sharedPending: coediting.hasSharedChanges.value,
									alone: coediting.isAlone.value,
								}
							: null,
				});
			},
			// Synchronous: Publish reads it right before it dispatches, and must
			// not see a session that was written (or changed) a moment ago as before.
			{ immediate: true, flush: 'sync' }
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
		recovery: autosave.recovery,
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
