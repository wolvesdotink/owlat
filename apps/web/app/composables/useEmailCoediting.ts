import { computed, nextTick, onUnmounted, ref, shallowRef, watch, type WatchSource } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import { coeditBlockKey, type CoeditDocument, type CoeditOp } from '@owlat/shared/coeditOps';
import { CoeditSync, type CoeditOutgoing, type CoeditServerState } from '~/lib/coeditSync';

/**
 * Live co-editing of one email (docs/adr/0071-email-coediting.md): keeps this
 * tab's editor in step with the shared session everyone editing the email
 * works on. The sync rules live in `lib/coeditSync.ts`; this wires them to
 * Convex and to the editor bridge.
 *
 * - `open` joins (or creates) the session once the member is known to be
 *   allowed to edit emails; a session that has nothing unsaved follows the
 *   email row when it changes elsewhere (`rowRevision`).
 * - Every local edit is sent shortly after it is made as block operations;
 *   other people's edits arrive through the session subscription and are
 *   applied through `applyRemote`, which keeps the selection and undo history.
 * - `status` stays `connecting` until the first session state is shown and
 *   turns `unavailable` when this member cannot co-edit (no permission, or
 *   joining failed); the bridge then edits the classic way.
 */

export type CoeditTarget =
	| { type: 'emailTemplate'; id: Id<'emailTemplates'> }
	| { type: 'transactionalEmail'; id: Id<'transactionalEmails'> };

export type CoeditStatus = 'connecting' | 'active' | 'unavailable';

/** One editor's state: the email's blocks plus the fields it shares. */
export type CoeditEditorDoc = CoeditDocument<EditorBlock>;

export interface EmailCoeditingOptions {
	/** The email being edited, or null while it is not known. */
	target: () => CoeditTarget | null;
	/** The email row's `contentRevision` as the tab last loaded it. */
	rowRevision: () => number | undefined;
	/** What the editor shows now. */
	read: () => CoeditEditorDoc;
	/** Show a whole state: the first one, or after choosing the latest version. */
	hydrate: (doc: CoeditEditorDoc) => void;
	/** Apply other people's edits to what the editor shows. */
	applyRemote: (ops: CoeditOp<EditorBlock>[]) => void;
	/** Values that change with every local edit. */
	changeSignals: WatchSource<unknown>[];
}

/** The editor fields a session shares (`lib/validators/coediting.ts` on the server). */
type CoeditFieldName = 'name' | 'subject' | 'plainTextOverride' | 'attachments' | 'showUnsubscribe';

/** How long local edits gather before they are sent. */
const SEND_DELAY_MS = 250;
/** Retry delay after a send failed (doubles up to the cap). */
const RETRY_MS = 2000;
const RETRY_CAP_MS = 15_000;
/** How long `flushNow` waits for the server to catch up on each round. */
const CATCH_UP_MS = 3000;

function newClientId(): string {
	return typeof crypto !== 'undefined' && 'randomUUID' in crypto
		? crypto.randomUUID()
		: `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The wire form of one outgoing operation (blocks and values as JSON text). */
function serialize({ op, baseVersion }: CoeditOutgoing<EditorBlock>) {
	switch (op.kind) {
		case 'insert':
		case 'update':
			return { kind: op.kind, block: JSON.stringify(op.block), afterId: op.afterId, baseVersion };
		case 'delete':
			return { kind: op.kind, blockId: op.blockId, baseVersion };
		case 'move':
			return { kind: op.kind, blockId: op.blockId, afterId: op.afterId };
		case 'field':
			return {
				kind: op.kind,
				field: op.field as CoeditFieldName,
				value: JSON.stringify(op.value),
				baseVersion,
			};
	}
}

function isSessionGone(error: unknown): boolean {
	const data = (error as { data?: { data?: { reason?: unknown } } } | null)?.data;
	return data?.data?.reason === 'coedit_session_gone';
}

export function useEmailCoediting(opts: EmailCoeditingOptions) {
	const client = useConvex();
	const { can, isRoleLoading } = usePermissions();
	const clientId = newClientId();
	let sync = new CoeditSync<EditorBlock>();

	const status = ref<CoeditStatus>('connecting');
	/** The session's bookkeeping (version, saved version, row revision it is based on). */
	const meta = shallowRef<Omit<CoeditServerState<EditorBlock>, 'doc'> | null>(null);
	const hasUnsent = ref(false);
	/** Sends are failing; edits are kept and retried. */
	const isOffline = ref(false);

	const canCoedit = computed(() => !isRoleLoading.value && can('templates:manage'));
	const target = computed(() => opts.target());

	// ── Joining ──────────────────────────────────────────────────────────
	let isOpening = false;
	// Nothing the session query delivers is shown before this tab's first
	// `open` landed: that call drops an idle session (and brings a clean one up
	// to date), and a state read before it could still be the dropped draft,
	// which this tab would then carry into the new session as its own work.
	// Once `open` resolves, the query already reflects it.
	let hasJoined = false;
	const open = async () => {
		const current = target.value;
		if (!client || !current || isOpening) return;
		isOpening = true;
		let isOpen = false;
		try {
			await client.mutation(api.emailCoediting.sessions.open, { target: current });
			isOpen = true;
		} catch {
			if (status.value === 'connecting') status.value = 'unavailable';
		} finally {
			isOpening = false;
		}
		if (isOpen && !hasJoined) {
			hasJoined = true;
			onSession(session.value);
		}
	};

	// Another email in the same editor: start over with it.
	watch(
		() => (target.value ? `${target.value.type}:${target.value.id}` : null),
		(next, prev) => {
			if (prev === undefined || prev === null || next === prev) return;
			sync = new CoeditSync<EditorBlock>();
			meta.value = null;
			hasJoined = false;
			if (status.value === 'active') status.value = 'connecting';
		}
	);

	watch(
		[target, isRoleLoading, canCoedit],
		([current, roleLoading, allowed]) => {
			if (!current || roleLoading) return;
			if (!allowed) {
				status.value = 'unavailable';
				return;
			}
			void open();
		},
		{ immediate: true }
	);

	const { data: session } = useConvexQuery(api.emailCoediting.sessions.get, () =>
		target.value && status.value !== 'unavailable' ? { target: target.value } : 'skip'
	);

	// ── Waiting for the server ──────────────────────────────────────────
	let waiters: Array<() => void> = [];
	const notifyWaiters = () => {
		const ready = waiters;
		waiters = [];
		for (const resolve of ready) resolve();
	};
	const nextChange = (ms: number) =>
		new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			waiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});

	// ── Sending ─────────────────────────────────────────────────────────
	let sendTimer: ReturnType<typeof setTimeout> | null = null;
	let retryMs = RETRY_MS;
	const refreshUnsent = () => {
		hasUnsent.value = sync.hasUnsent(opts.read());
	};

	const send = async (): Promise<boolean> => {
		const current = target.value;
		// The canvas reports its edits after the render that made them.
		await nextTick();
		// Bound to this email's sync even if the editor moves on meanwhile.
		const owner = sync;
		const batch = current ? owner.outgoing(opts.read()) : null;
		if (!client || !current || !batch) return false;
		owner.sent(batch);
		try {
			const result = await client.mutation(api.emailCoediting.sessions.applyOps, {
				target: current,
				clientId,
				ops: batch.ops.map(serialize),
			});
			owner.acked(result.version);
			isOffline.value = false;
			retryMs = RETRY_MS;
			return true;
		} catch (error) {
			owner.failed();
			if (isSessionGone(error)) {
				void open();
			} else {
				isOffline.value = true;
				scheduleSend(retryMs);
				retryMs = Math.min(retryMs * 2, RETRY_CAP_MS);
			}
			return false;
		} finally {
			refreshUnsent();
			notifyWaiters();
		}
	};

	function scheduleSend(delay = SEND_DELAY_MS) {
		if (status.value !== 'active' || sendTimer !== null) return;
		sendTimer = setTimeout(() => {
			sendTimer = null;
			void send().then((didSend) => {
				if (didSend && sync.hasUnsent(opts.read())) scheduleSend();
			});
		}, delay);
	}

	watch(opts.changeSignals, () => {
		if (status.value !== 'active') return;
		refreshUnsent();
		scheduleSend();
	});

	/**
	 * Send everything this tab has and wait until the server applied it, so a
	 * save that follows includes it. Gives up after a few rounds; what is
	 * still unsent then stays unsaved (the editor stays dirty).
	 */
	const flushNow = async () => {
		if (sendTimer !== null) {
			clearTimeout(sendTimer);
			sendTimer = null;
		}
		for (let round = 0; round < 5; round++) {
			if (!sync.hasUnsent(opts.read())) return;
			if (!(await send())) await nextChange(CATCH_UP_MS);
		}
	};

	// ── Receiving ───────────────────────────────────────────────────────
	function onSession(row: typeof session.value) {
		if (row === undefined || !hasJoined || status.value === 'unavailable') return;
		if (row === null) {
			// Not created yet, or it ended while this tab was away: (re)join.
			void open();
			return;
		}
		const state: CoeditServerState<EditorBlock> = {
			sessionId: row.sessionId,
			version: row.version,
			savedVersion: row.savedVersion,
			baseRevision: row.baseRevision,
			doc: {
				blocks: JSON.parse(row.content) as EditorBlock[],
				fields: JSON.parse(row.fields) as Record<string, unknown>,
			},
		};
		const result = sync.receive(state, opts.read());
		const known = sync.server ?? state;
		meta.value = {
			sessionId: known.sessionId,
			version: known.version,
			savedVersion: known.savedVersion,
			baseRevision: known.baseRevision,
		};
		if (result?.kind === 'hydrate') {
			opts.hydrate(result.doc);
			status.value = 'active';
		} else if (result?.kind === 'merge' && result.ops.length > 0) {
			opts.applyRemote(result.ops);
		}
		notifyWaiters();
		refreshUnsent();
		if (hasUnsent.value) scheduleSend();
	}
	watch(session, onSession);

	// A session with nothing unsaved follows the email when it changes
	// elsewhere (the translations page, an API write).
	watch([meta, () => opts.rowRevision()], ([current, revision]) => {
		if (!current || revision === undefined) return;
		if (current.version === current.savedVersion && current.baseRevision !== revision) {
			void open();
		}
	});

	// ── Choices ─────────────────────────────────────────────────────────
	let isDiscarding = false;
	/**
	 * Throw away the shared unsaved changes, everyone's, and this tab's unsent
	 * ones: the session goes back to the email as saved.
	 */
	const resetShared = async () => {
		const current = target.value;
		if (!client || !current) return;
		isDiscarding = true;
		sync.adoptNextState();
		try {
			await client.mutation(api.emailCoediting.sessions.reset, { target: current });
		} finally {
			isDiscarding = false;
		}
	};

	/** Wait (briefly) until the session reports a save of at least `version`. */
	const untilSaved = async (version: number) => {
		for (let round = 0; round < 2; round++) {
			if ((meta.value?.savedVersion ?? 0) >= version) return;
			await nextChange(CATCH_UP_MS);
		}
	};

	const hasSharedChanges = computed(
		() => meta.value !== null && meta.value.version > meta.value.savedVersion
	);

	onUnmounted(() => {
		if (sendTimer !== null) clearTimeout(sendTimer);
		// Best effort: hand over what this tab still has before it goes, unless
		// it is leaving because it threw its changes away.
		if (status.value === 'active' && !isDiscarding) void send();
		notifyWaiters();
	});

	return {
		clientId,
		status,
		meta,
		target,
		hasUnsent,
		hasSharedChanges,
		isOffline,
		/** Hold the version `blockId` was seen at while this tab edits it (edit lease). */
		pinBlock: (blockId: string) => sync.pin(coeditBlockKey(blockId)),
		unpinBlock: (blockId: string) => sync.unpin(coeditBlockKey(blockId)),
		/** The session version this tab has seen, for a save to name. */
		seenVersion: () => sync.server?.version,
		flushNow,
		untilSaved,
		resetShared,
	};
}

export type EmailCoediting = ReturnType<typeof useEmailCoediting>;
