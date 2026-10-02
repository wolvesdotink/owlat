import { computed, ref, watch, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { BuilderCollabFocus, EditorBlock } from '@owlat/email-builder';
import { applyCoeditOps, type CoeditOp } from '@owlat/shared/coeditOps';
import { canonicalJson } from '@owlat/shared/canonicalJson';
import { useEmailCoediting, type CoeditEditorDoc, type CoeditTarget } from './useEmailCoediting';
import { useEmailEditorPresence } from './useEmailEditorPresence';

/**
 * The email editor bridge's co-editing half (docs/adr/0071-email-coediting.md):
 * binds the live session (`useEmailCoediting`) and presence
 * (`useEmailEditorPresence`) to the bridge's canvas refs and the mounted
 * EmailBuilder, and turns "your change was replaced" notices into something
 * the editor can show and undo.
 */

/** What the bridge hands over: its canvas refs and the builder. */
export interface EmailEditorCoeditHost {
	blocks: Ref<EditorBlock[]>;
	name: Ref<string>;
	subject: Ref<string>;
	/** The surface's other shared refs, keyed by session field name. */
	fields: Record<string, Ref<unknown>>;
	/** Changes with every write to the canvas blocks. */
	blocksVersion: Readonly<Ref<number>>;
	builder: () => {
		loadState: (state: { blocks: EditorBlock[]; name: string; subject: string }) => void;
		applyRemoteOps?: (ops: CoeditOp<EditorBlock>[]) => void;
	} | null;
}

/** A replaced change, ready to show. */
export interface CoeditNoticeView {
	noticeId: Id<'emailCoeditNotices'>;
	/** The block or field the change was to. */
	kind: 'block' | 'field';
	/** Field name, for a field notice. */
	field: string | null;
	/** Who replaced it. */
	replacedBy: string;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function useEmailEditorCoedit(
	target: () => CoeditTarget | null,
	host: EmailEditorCoeditHost,
	rowRevision: () => number | undefined
) {
	const { t } = useI18n();
	const client = useConvex();
	const { members } = useOrganization();

	const read = (): CoeditEditorDoc => {
		const fields: Record<string, unknown> = { name: host.name.value, subject: host.subject.value };
		for (const [key, field] of Object.entries(host.fields)) fields[key] = field.value;
		return { blocks: host.blocks.value, fields };
	};

	const setField = (key: string, value: unknown) => {
		if (key === 'name') host.name.value = String(value ?? '');
		else if (key === 'subject') host.subject.value = String(value ?? '');
		else {
			const field = host.fields[key];
			if (field) field.value = clone(value);
		}
	};

	/** Show a whole state, as the builder's explicit load path. */
	const hydrate = (doc: CoeditEditorDoc) => {
		const blocks = clone(doc.blocks) as EditorBlock[];
		host.blocks.value = blocks;
		for (const [key, value] of Object.entries(doc.fields)) setField(key, value);
		host.builder()?.loadState({ blocks, name: host.name.value, subject: host.subject.value });
	};

	/** Other people's edits: through the builder, which keeps selection and undo. */
	const applyRemote = (incoming: CoeditOp<EditorBlock>[]) => {
		const ops = clone(incoming);
		const builder = host.builder();
		const shared = ops.filter(
			(op) => op.kind !== 'field' || op.field === 'name' || op.field === 'subject'
		);
		if (builder?.applyRemoteOps) {
			builder.applyRemoteOps(shared);
		} else {
			// No canvas (the window is too narrow for it): the refs are the state.
			const next = applyCoeditOps(read(), shared);
			host.blocks.value = next.blocks as EditorBlock[];
			host.name.value = String(next.fields['name'] ?? host.name.value);
			host.subject.value = String(next.fields['subject'] ?? host.subject.value);
		}
		for (const op of ops) {
			if (op.kind === 'field' && op.field !== 'name' && op.field !== 'subject') {
				setField(op.field, op.value);
			}
		}
		presence.acceptRemote(ops);
	};

	// Every local edit: a block write, or a change to any shared field.
	const changeSignals = [
		host.blocksVersion,
		() => canonicalJson(Object.fromEntries(Object.entries(read().fields))),
	];

	const session = useEmailCoediting({
		target,
		rowRevision,
		read,
		hydrate,
		applyRemote,
		changeSignals,
	});

	const focus = ref<BuilderCollabFocus>({ selectedRootId: null, inlineEditRootId: null });
	const presence = useEmailEditorPresence({
		target,
		clientId: session.clientId,
		enabled: () => session.status.value === 'active',
		focus,
		readBlock: (rootId) => host.blocks.value.find((block) => block.id === rootId),
		changeSignals: [host.blocksVersion],
		onLeaseChange: (next, previous) => {
			if (previous) session.unpinBlock(previous);
			if (next) session.pinBlock(next);
		},
	});

	// ── Notices ─────────────────────────────────────────────────────────
	const { data: noticeRows } = useConvexQuery(api.emailCoediting.notices.listForClient, () =>
		session.status.value === 'active' ? { clientId: session.clientId } : 'skip'
	);
	const nameOf = (userId: string) => {
		const member = members.value.find((m) => m.userId === userId);
		return member ? member.user.name || member.user.email : t('shared.editorPresence.someone');
	};
	const notices = computed<CoeditNoticeView[]>(() =>
		(noticeRows.value ?? []).map((row) => ({
			noticeId: row.noticeId,
			kind: row.key.startsWith('field:') ? 'field' : 'block',
			field: row.key.startsWith('field:') ? row.key.slice('field:'.length) : null,
			replacedBy: nameOf(row.replacedBy),
		}))
	);

	const dismissNotice = async (noticeId: Id<'emailCoeditNotices'>) => {
		await client?.mutation(api.emailCoediting.notices.dismiss, {
			noticeId,
			clientId: session.clientId,
		});
	};

	/**
	 * Put the replaced change back, as an ordinary (undoable) edit of this tab
	 * that goes out to everyone. A block someone deleted meanwhile comes back
	 * at the top of the email.
	 */
	const restoreNotice = async (noticeId: Id<'emailCoeditNotices'>) => {
		const row = noticeRows.value?.find((notice) => notice.noticeId === noticeId);
		if (!row) return;
		const value = JSON.parse(row.replacedValue) as unknown;
		const doc = read();
		if (row.key.startsWith('field:')) {
			setField(row.key.slice('field:'.length), value);
		} else {
			const block = value as EditorBlock;
			const op: CoeditOp<EditorBlock> = { kind: 'update', block, afterId: null };
			hydrate(applyCoeditOps({ blocks: [...doc.blocks], fields: doc.fields }, [op]));
		}
		await dismissNotice(noticeId);
	};

	/** Leaving would drop unsaved work only when nobody else is there to keep it. */
	const isAlone = computed(() => presence.people.value.length === 0);

	watch(
		() => session.status.value,
		(status) => {
			if (status !== 'active') focus.value = { selectedRootId: null, inlineEditRootId: null };
		}
	);

	return {
		...session,
		people: presence.people,
		remoteMarks: presence.remoteMarks,
		isAlone,
		notices,
		dismissNotice,
		restoreNotice,
		onCollabFocus: (value: BuilderCollabFocus) => {
			focus.value = value;
		},
	};
}

export type EmailEditorCoedit = ReturnType<typeof useEmailEditorCoedit>;
