import type { Ref } from 'vue';
import { usePostboxListKeyboard } from '~/composables/postbox/usePostboxListKeyboard';
import { useShortcutLabels } from '~/composables/useShortcutLabels';
import { useShortcutScope } from '~/composables/useShortcutScope';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import { resolveActiveChord } from '~/utils/shortcutScope';

/**
 * The Team inbox Updates list's keyboard. Every key of it is a `review` entry
 * (move, open, Done, Draft a reply), so a remap moves it, two of them can
 * never share a key, and the "?" sheet lists them while the page claims the
 * scope. The legend reads the same bindings; Done and Draft a reply have no
 * place in the spam view.
 */
export function useReviewListKeys<T extends { _id: string }>(opts: {
	items: Ref<T[]>;
	resetKey: Ref<unknown>;
	rowDomId: (row: T) => string;
	onOpen: (row: T) => void;
	onDismiss: (row: T) => void;
	onRequestReply: (row: T) => void;
}) {
	useShortcutScope('review');
	const list = usePostboxListKeyboard<T>({
		items: opts.items,
		resetKey: opts.resetKey,
		rowDomId: opts.rowDomId,
		scope: 'review',
		onActivate: opts.onOpen,
		onAction: (key, row) => {
			const id = resolveActiveChord(key, ['review']);
			if (id === 'review.dismiss') opts.onDismiss(row);
			else if (id === 'review.requestReply') opts.onRequestReply(row);
		},
	});

	function onKeydown(event: KeyboardEvent) {
		if (isEditableTarget(event.target)) return;
		list.onKeydown(event);
	}

	const { keyHints } = useShortcutLabels();
	const hints = computed(() =>
		keyHints([
			{ id: ['review.next', 'review.previous'], label: 'dashboard.inbox.updates.hintMove' },
			{ id: 'review.open', label: 'dashboard.inbox.updates.hintOpen' },
			{ id: 'review.dismiss', label: 'dashboard.inbox.updates.dismiss', notInSpam: true },
			{ id: 'review.requestReply', label: 'dashboard.inbox.updates.requestReply', notInSpam: true },
		])
	);

	return { focusedIndex: list.focusedIndex, activeId: list.activeId, onKeydown, hints };
}
