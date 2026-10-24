import { computed, ref, type Ref } from 'vue';
import type { EditorBlock } from '@owlat/email-builder';
import { canonicalJson } from '@owlat/shared/canonicalJson';
import { editorDraftScope, type EditorDraftKind } from '~/utils/editorDraftStore';
import { useDraftAutosave, type DraftAutosave } from './useDraftAutosave';
import { useDraftRecovery, type DraftRecovery } from './useDraftRecovery';
import type { EmailEditorBridgeContext, EmailBuilderHandle } from './useEmailEditorBridge';
import type { EmailEditorCoedit } from './useEmailEditorCoedit';

/**
 * The email editor bridge's autosave half (`useEmailEditorBridge.ts`): wires
 * the draft autosave (`useDraftAutosave.ts`) and the device-copy recovery
 * (`useDraftRecovery.ts`) to the canvas.
 *
 * Classic editing saves after every pause in this tab's edits. Live
 * co-editing already keeps every edit in the shared session on the server;
 * what autosave adds there is writing the session to the email, and only for
 * edits made in this tab (or when nobody else is left to do it), so several
 * open tabs do not all save the same change.
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

export interface EmailEditorAutosaveHost {
	ctx: EmailEditorBridgeContext;
	extraWatch: Ref<unknown>[];
	blocksVersion: Readonly<Ref<number>>;
	builder: () => EmailBuilderHandle | null;
	coediting: EmailEditorCoedit | null;
	isLive: () => boolean;
	/** The classic draft has loaded the row. */
	isInitialized: () => boolean;
	/** The loaded row's revision (the device copy's base). */
	rowRevision: () => number | undefined;
	hasChanges: () => boolean;
	/** A stale-revision choice is open. */
	hasConflict: () => boolean;
	/** One save through the bridge's queue (rejects when it did not land). */
	save: () => Promise<void>;
}

export interface EmailEditorAutosave {
	autosave: DraftAutosave;
	recovery: DraftRecovery<EmailDraftSnapshot>;
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

export function useEmailEditorAutosave(
	opts: EmailEditorAutosaveOptions,
	host: EmailEditorAutosaveHost
): EmailEditorAutosave {
	const { user, activeOrganizationId } = useAuth();
	const { showToast } = useToast();
	const { t } = useI18n();
	const { ctx, extraWatch, coediting } = host;

	const scope = computed(() => {
		const id = opts.id();
		const userId = user.value?.id;
		const organizationId = activeOrganizationId.value;
		return id && userId && organizationId
			? editorDraftScope({ userId, organizationId, kind: opts.kind, id })
			: null;
	});

	const snapshot = (): EmailDraftSnapshot => ({
		name: ctx.name.value,
		subject: ctx.subject.value,
		blocks: ctx.blocks.value,
		extra: extraWatch.map((field) => field.value),
	});

	// Live: the edits this tab sent since its last landed save.
	const savedLocalEdits = ref(0);
	const hasOwnEdits = () => (coediting?.localEdits.value ?? 0) !== savedLocalEdits.value;

	const autosave = useDraftAutosave<EmailDraftSnapshot>({
		enabled: opts.enabled,
		// Live with others there: their tabs save their own edits.
		paused: () =>
			host.hasConflict() || (host.isLive() && coediting?.isAlone.value !== true && !hasOwnEdits()),
		dirty: host.hasChanges,
		changes: [
			() => (host.isLive() ? -1 : host.blocksVersion.value),
			() => (host.isLive() ? null : ctx.name.value),
			() => (host.isLive() ? null : ctx.subject.value),
			() => (host.isLive() ? null : canonicalJson(extraWatch.map((field) => field.value))),
			() => coediting?.localEdits.value ?? 0,
		],
		save: async () => {
			const covers = coediting?.localEdits.value ?? 0;
			await host.save();
			savedLocalEdits.value = Math.max(savedLocalEdits.value, covers);
		},
		uncommitted: () => host.builder()?.isInlineEditing === true,
		commit: () => host.builder()?.commitInlineEdit?.(),
		mirror: {
			scope: () => scope.value,
			snapshot,
			base: () => host.rowRevision() ?? null,
		},
	});

	const apply = (data: EmailDraftSnapshot) => {
		ctx.name.value = data.name;
		ctx.subject.value = data.subject;
		ctx.blocks.value = data.blocks;
		for (const [i, field] of extraWatch.entries()) {
			if (i < data.extra.length) field.value = data.extra[i];
		}
		host.builder()?.loadState({ blocks: data.blocks, name: data.name, subject: data.subject });
	};

	const recovery = useDraftRecovery<EmailDraftSnapshot>({
		scope: () => scope.value,
		ready: () =>
			opts.enabled() &&
			(coediting?.status.value === 'connecting' ? false : host.isLive() || host.isInitialized()),
		accept: isSnapshot,
		matches: (data) => canonicalJson(data) === canonicalJson(snapshot()),
		// Only over the very state it was built on: the row at the same
		// revision, and (live) a session holding nothing unsaved by anyone.
		canApply: (copy) =>
			copy.base !== null &&
			copy.base === host.rowRevision() &&
			!(host.isLive() && coediting?.hasSharedChanges.value === true),
		apply,
		edits: () => autosave.edits.value,
		keep: autosave.keep,
		onApplied: () => showToast(t('shared.draftAutosave.restored')),
	});

	return { autosave, recovery };
}
