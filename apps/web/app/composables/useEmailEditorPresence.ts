import { computed, onMounted, onUnmounted, ref, watch, type Ref, type WatchSource } from 'vue';
import { api } from '@owlat/api';
import type { BuilderCollabFocus, EditorBlock, RemoteBlockMark } from '@owlat/email-builder';
import { canonicalJson } from '@owlat/shared/canonicalJson';
import { AVATAR_COLOR_STYLES, initialsAndColorForAddress } from '~/utils/avatar';
import type { CoeditTarget } from './useEmailCoediting';

/**
 * Who else has this email open in the editor, and which block each of them
 * is on (docs/adr/0071-email-coediting.md). Drives the avatar stack in the
 * editor toolbar and the coloured outline with a name on the blocks others
 * have selected or are editing.
 *
 * The tab heartbeats every 10s while it is visible (and at once when its
 * selection or lease changes), naming the root block it has selected and the
 * block it is editing. Editing is an edit lease on the block: taken when the
 * inline text editor opens on it, or when this tab changes the selected
 * block; given up when the selection moves on, the tab is hidden or closed.
 * While someone else holds a block, the editor will not select it here.
 * Mirrors shared-inbox thread presence (useThreadPresence.ts).
 */

/** Client heartbeat cadence; the server keeps a row active for 35s and a lease for 20s. */
const HEARTBEAT_MS = 10_000;
const PRESENCE_WINDOW_MS = 35_000;
/** How often the server clock is advanced locally to expire rows and leases. */
const CLOCK_TICK_MS = 5000;

/** One other person in the editor, resolved for display. */
export interface EditorPerson {
	userId: string;
	name: string;
	email: string | null;
	image: string | null;
	color: string;
	isEditing: boolean;
}

export interface EmailEditorPresenceOptions {
	target: () => CoeditTarget | null;
	clientId: string;
	/** Heartbeat only while co-editing is live. */
	enabled: () => boolean;
	/** What this tab has selected and is typing in (the builder's `collab-focus`). */
	focus: Ref<BuilderCollabFocus>;
	/** The current root block with this id, to notice that this tab changed it. */
	readBlock: (rootId: string) => EditorBlock | undefined;
	/** Values that change with every local edit. */
	changeSignals: WatchSource<unknown>[];
	/** The lease moved: from `previous` to `next` (either may be null). */
	onLeaseChange?: (next: string | null, previous: string | null) => void;
}

export function useEmailEditorPresence(opts: EmailEditorPresenceOptions) {
	const { t } = useI18n();
	const client = useConvex();
	const { members, hasResolvedMembers, fetchMembers } = useOrganization();
	const target = computed(() => opts.target());
	const enabled = computed(() => opts.enabled() && target.value !== null);

	// ── This tab's lease ────────────────────────────────────────────────
	// The selected root as it was when it was selected; a change to it means
	// this tab is editing it.
	let selectedSnapshot: string | null = null;
	const editedRootId = ref<string | null>(null);
	const snapshotOf = (rootId: string | null) => {
		const block = rootId ? opts.readBlock(rootId) : undefined;
		return block ? canonicalJson(block) : null;
	};
	watch(
		() => opts.focus.value.selectedRootId,
		(rootId) => {
			editedRootId.value = null;
			selectedSnapshot = snapshotOf(rootId);
		},
		{ immediate: true }
	);
	watch(opts.changeSignals, () => {
		const rootId = opts.focus.value.selectedRootId;
		if (!rootId || editedRootId.value === rootId) return;
		if (snapshotOf(rootId) !== selectedSnapshot) editedRootId.value = rootId;
	});
	const leaseBlockId = computed<string | null>(() => {
		const { inlineEditRootId, selectedRootId } = opts.focus.value;
		if (inlineEditRootId) return inlineEditRootId;
		return editedRootId.value !== null && editedRootId.value === selectedRootId
			? editedRootId.value
			: null;
	});
	watch(leaseBlockId, (next, previous) => {
		if (next !== previous) opts.onLeaseChange?.(next, previous ?? null);
	});

	// ── Heartbeat ───────────────────────────────────────────────────────
	const isHidden = () => typeof document !== 'undefined' && document.hidden;
	let timer: ReturnType<typeof setInterval> | null = null;

	const beat = async () => {
		const current = target.value;
		if (!client || !current || !enabled.value || isHidden()) return;
		try {
			await client.mutation(api.emailCoediting.presence.heartbeat, {
				target: current,
				clientId: opts.clientId,
				selectedBlockId: opts.focus.value.selectedRootId,
				leaseBlockId: leaseBlockId.value,
			});
		} catch {
			// Best effort: the next beat retries, and the server drops a row
			// that stops beating.
		}
	};
	const leave = () => {
		if (!client) return;
		client.mutation(api.emailCoediting.presence.leave, { clientId: opts.clientId }).catch(() => {
			// The sweep removes the row once it stops beating.
		});
	};
	const stop = () => {
		if (timer !== null) clearInterval(timer);
		timer = null;
	};
	const start = () => {
		stop();
		if (!enabled.value || isHidden()) return;
		void beat();
		timer = setInterval(() => void beat(), HEARTBEAT_MS);
	};
	const onVisibilityChange = () => {
		// Hidden: stop beating, so the lease runs out and others can edit.
		if (isHidden()) stop();
		else start();
	};

	watch(enabled, (on) => {
		if (on) {
			start();
			return;
		}
		stop();
		leave();
	});
	watch([() => opts.focus.value.selectedRootId, leaseBlockId], () => void beat());
	watch(
		() => (target.value ? `${target.value.type}:${target.value.id}` : null),
		(next, prev) => {
			if (prev && next !== prev) start();
		}
	);

	// ── Everyone else ───────────────────────────────────────────────────
	const { data } = useConvexQuery(api.emailCoediting.presence.list, () =>
		enabled.value && target.value ? { target: target.value } : 'skip'
	);
	// The server clock as of the last list, advanced locally, so rows and
	// leases expire on time whatever this machine's clock says.
	const clockOffset = ref(0);
	const tick = ref(Date.now());
	watch(data, (list) => {
		if (list) clockOffset.value = list.now - Date.now();
	});
	let clock: ReturnType<typeof setInterval> | null = null;
	const serverNow = computed(() => tick.value + clockOffset.value);

	const others = computed(() =>
		(data.value?.people ?? []).filter(
			(row) =>
				row.clientId !== opts.clientId && row.heartbeatAt > serverNow.value - PRESENCE_WINDOW_MS
		)
	);

	const resolve = (userId: string) => {
		const member = members.value.find((m) => m.userId === userId);
		const name = member
			? member.user.name || member.user.email
			: t('shared.editorPresence.someone');
		const email = member?.user.email ?? null;
		const token = initialsAndColorForAddress(name, { colorKey: email ?? undefined }).colorToken;
		return {
			name,
			email,
			image: member?.user.image ?? null,
			color: AVATAR_COLOR_STYLES[token].background,
		};
	};

	const isLeaseAlive = (row: { leaseBlockId: string | null; leaseExpiresAt: number | null }) =>
		row.leaseBlockId !== null && (row.leaseExpiresAt ?? 0) > serverNow.value;

	/** One entry per person (several tabs of one person show once). */
	const people = computed<EditorPerson[]>(() => {
		const byUser = new Map<string, EditorPerson>();
		for (const row of others.value) {
			const existing = byUser.get(row.userId);
			if (existing) {
				existing.isEditing ||= isLeaseAlive(row);
				continue;
			}
			byUser.set(row.userId, {
				userId: row.userId,
				...resolve(row.userId),
				isEditing: isLeaseAlive(row),
			});
		}
		return [...byUser.values()];
	});

	/** The outline and label for every root block someone else is on. */
	const remoteMarks = computed<Record<string, RemoteBlockMark>>(() => {
		const marks: Record<string, RemoteBlockMark> = {};
		for (const row of others.value) {
			const person = resolve(row.userId);
			if (isLeaseAlive(row)) {
				marks[row.leaseBlockId!] = {
					label: t('shared.editorPresence.isEditing', { name: person.name }),
					color: person.color,
					isLocked: true,
				};
			}
		}
		for (const row of others.value) {
			const rootId = row.selectedBlockId;
			if (rootId && !marks[rootId]) {
				const person = resolve(row.userId);
				marks[rootId] = { label: person.name, color: person.color, isLocked: false };
			}
		}
		return marks;
	});

	onMounted(() => {
		if (!hasResolvedMembers.value) void fetchMembers();
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', onVisibilityChange);
		}
		clock = setInterval(() => {
			tick.value = Date.now();
		}, CLOCK_TICK_MS);
		start();
	});

	onUnmounted(() => {
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', onVisibilityChange);
		}
		if (clock !== null) clearInterval(clock);
		stop();
		leave();
	});

	return { people, remoteMarks, leaseBlockId };
}
