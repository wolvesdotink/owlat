import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { Placement } from '@owlat/shared/arrival';
import { inject, provide, shallowRef, type InjectionKey, type Ref, type ShallowRef } from 'vue';
import {
	POSTBOX_WHY_HERE_KEY,
	type PostboxWhyHereTarget,
} from '~/composables/postbox/usePostboxWhyHere';
import { usePostboxArrivalUndo } from '~/composables/postbox/usePostboxArrivalUndo';

/** Where Fix can send mail (`api.mail.arrival.fix.apply`). */
export type PostboxFixDestination = 'needs_me' | 'today' | 'updates' | 'digest' | 'auto_archive';
export type PostboxFixScope = 'message' | 'sender';

export const POSTBOX_FIX_DESTINATIONS: readonly PostboxFixDestination[] = [
	'needs_me',
	'today',
	'updates',
	'digest',
	'auto_archive',
];

/** What the Fix dialog acts on. */
export interface PostboxFixTarget {
	messageId: Id<'mailMessages'>;
	senderName: string;
	/** Where the thread sits now (the dialog preselects it). */
	placement?: Placement;
}

interface ExplainHost {
	mailboxId: Ref<Id<'mailboxes'>>;
	why: ShallowRef<PostboxWhyHereTarget | null>;
	fix: ShallowRef<PostboxFixTarget | null>;
}

const EXPLAIN_HOST_KEY: InjectionKey<ExplainHost> = Symbol('postboxArrivalExplainHost');

/** "Always here" for a placement: the Fix destination that keeps it there. */
export function destinationForPlacement(placement: Placement): PostboxFixDestination {
	return placement === 'archived' ? 'auto_archive' : placement;
}

/**
 * Read on arrival §4.1: the host of "Why here?" and Fix. PostboxLayout calls it
 * once; it answers the web-reader seam (`POSTBOX_WHY_HERE_KEY`) for the reader
 * and the Priority view below it, and `PostboxArrivalExplain` (also under the
 * layout) renders the popover and the dialog from the state it provides.
 */
export function usePostboxArrivalExplainHost(mailboxId: Ref<Id<'mailboxes'>>): ExplainHost {
	const host: ExplainHost = { mailboxId, why: shallowRef(null), fix: shallowRef(null) };
	provide(POSTBOX_WHY_HERE_KEY, {
		open(target) {
			host.why.value = target;
		},
	});
	provide(EXPLAIN_HOST_KEY, host);
	return host;
}

/** The host state, for the components that render it. */
export function usePostboxArrivalExplainState(): ExplainHost {
	const host = inject(EXPLAIN_HOST_KEY, null);
	if (!host) throw new Error('usePostboxArrivalExplainState needs usePostboxArrivalExplainHost');
	return host;
}

/**
 * Apply one Fix and say what it did, with Undo (SPEC §4.2, §4.4). Shared by the
 * Fix dialog and the popover's "Always here".
 */
export function usePostboxFixApply() {
	const { t } = useI18n();
	const { offerUndo } = usePostboxArrivalUndo();
	const applyOp = useBackendOperation(api.mail.arrival.fix.apply, {
		label: () => t('postbox.fix.operation'),
	});

	async function apply(args: {
		messageId: Id<'mailMessages'>;
		destination: PostboxFixDestination;
		scope: PostboxFixScope;
		reason?: string;
		senderName: string;
	}): Promise<boolean> {
		const reason = args.reason?.trim();
		const run = await applyOp.run({
			messageId: args.messageId,
			destination: args.destination,
			scope: args.scope,
			...(reason ? { reason } : {}),
		});
		if (!run.ok) return false;
		const result = run.result;
		const name = args.senderName || result.displayName || result.address;
		let message: string;
		if (!result.operationId) message = t('postbox.fix.toast.unchanged');
		else if (result.archived > 0 && args.scope === 'sender') {
			message = t(
				'postbox.fix.toast.archivedSender',
				{ count: result.archived, name },
				result.archived
			);
		} else if (args.scope === 'sender') {
			message = t(`postbox.fix.toast.sender.${args.destination}`, { name });
		} else {
			message = t(`postbox.fix.toast.thread.${args.destination}`);
		}
		if (result.ruleDraftId) message = `${message} ${t('postbox.fix.toast.ruleDraft')}`;
		offerUndo(message, result.operationId);
		return true;
	}

	return { apply, isApplying: applyOp.isLoading };
}
