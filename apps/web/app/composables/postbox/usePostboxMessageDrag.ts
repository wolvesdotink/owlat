/**
 * Drag a thread-list row (or the whole bulk selection) onto the folder rail:
 * drop on a folder to move it there, drop on a label to apply the label.
 *
 * The source list starts a SESSION carrying the dragged ids and its own move
 * verb, so a drop runs the exact path `v` and the bulk bar's Move run —
 * optimistic hide, failure restore, "Undo — Cmd+Z" — instead of a second
 * implementation living in the rail. The rail's rows only ask two questions of
 * the session: may this drag land here (utils/postboxMessageDrag.ts), and
 * what happens when it does.
 *
 * The session is module state rather than `useState`: it holds a callback,
 * there is only ever one pointer dragging, and it exists only between a
 * client-side dragstart and its dragend, so there is nothing to serialise.
 */

import type { Id } from '@owlat/api/dataModel';
import {
	acceptsMessageDrop,
	dragMessageIds,
	POSTBOX_MESSAGE_DRAG_TYPE,
} from '~/utils/postboxMessageDrag';

export interface PostboxMessageDragSession {
	mailboxId: Id<'mailboxes'>;
	messageIds: Id<'mailMessages'>[];
	/** The list's folder (role or custom-folder id); null for label/search views. */
	sourceFolder: string | null;
	/** File the dragged rows into a folder, through the source list's own verb. */
	moveTo: (folderId: Id<'mailFolders'>) => Promise<unknown>;
}

const session = shallowRef<PostboxMessageDragSession | null>(null);
const draggedIds = computed(() => new Set<string>(session.value?.messageIds ?? []));

/**
 * The drag preview: a small pill ("Invoice 4471…" / "3 messages") instead of
 * the browser's snapshot of a full-width row, which covers the rail it is
 * being dragged onto. It only has to exist while `setDragImage` copies it.
 */
function setDragPreview(dataTransfer: DataTransfer, text: string) {
	const ghost = document.createElement('div');
	ghost.className = 'pbx-drag-ghost';
	ghost.textContent = text;
	document.body.appendChild(ghost);
	dataTransfer.setDragImage(ghost, 12, 12);
	setTimeout(() => ghost.remove(), 0);
}

export function usePostboxMessageDrag() {
	function start(event: DragEvent, next: PostboxMessageDragSession, previewText: string) {
		const dataTransfer = event.dataTransfer;
		if (!dataTransfer || next.messageIds.length === 0) return;
		session.value = next;
		// copyMove: a folder drop moves, a label drop copies (the row stays put).
		dataTransfer.effectAllowed = 'copyMove';
		dataTransfer.setData(POSTBOX_MESSAGE_DRAG_TYPE, JSON.stringify(next.messageIds));
		setDragPreview(dataTransfer, previewText);
	}

	function end() {
		session.value = null;
	}

	return {
		session: readonly(session),
		start,
		end,
		/** True for a row that is part of the drag in flight (the list dims it). */
		isDragged: (id: string) => draggedIds.value.has(id),
	};
}

/**
 * The source half for a thread list: what a grabbed row carries and what a
 * drop does with it. Grabbing a selected row carries the whole selection,
 * which a landed move then clears — the same outcome as the bulk bar's Move; any
 * other row travels alone. The move itself is the list's own `moveMany`, a
 * fifth entry point to the verb `v`, the bulk bar and the context menu share.
 */
export function usePostboxListRowDrag(opts: {
	mailboxId: Ref<Id<'mailboxes'>>;
	bulk: {
		ids: Ref<Id<'mailMessages'>[]>;
		isSelected: (id: Id<'mailMessages'>) => boolean;
		clear: () => void;
	};
	/** Resolves to whether the move landed. */
	moveMany: (ids: Id<'mailMessages'>[], folderId: Id<'mailFolders'>) => Promise<boolean>;
}) {
	const { t } = useI18n();
	const route = useRoute();
	const drag = usePostboxMessageDrag();

	/**
	 * The folder the list shows, as its route segment (a role, or a custom
	 * folder's id). Label views and search results have no `[folder]` segment:
	 * they are not one folder, so no destination is a no-op for them.
	 */
	function sourceFolder(): string | null {
		const param = route.params['folder'];
		return typeof param === 'string' && param !== '' ? param : null;
	}

	function start(row: { _id: Id<'mailMessages'>; subject: string }, event: DragEvent) {
		const carriesSelection = opts.bulk.isSelected(row._id);
		const messageIds = dragMessageIds(row._id, opts.bulk.ids.value);
		drag.start(
			event,
			{
				mailboxId: opts.mailboxId.value,
				messageIds,
				sourceFolder: sourceFolder(),
				moveTo: async (folderId) => {
					// Spent only once the move lands: a failed drop keeps the selection.
					if ((await opts.moveMany(messageIds, folderId)) && carriesSelection) {
						opts.bulk.clear();
					}
				},
			},
			messageIds.length > 1
				? t('components.postbox.postboxThreadList.dragCount', { count: messageIds.length })
				: row.subject || t('components.postbox.postboxThreadRow.noSubject')
		);
	}

	return { start };
}

/**
 * Drop-target wiring for the rail. `folder(row)` and `label(id, apply)` each
 * return a listener object for `v-on`, and `isOverFolder` / `isOverLabel` drive
 * the highlight of the one row the pointer is over.
 */
export function usePostboxMessageDropTargets(mailboxId: Ref<Id<'mailboxes'> | null | undefined>) {
	const { end } = usePostboxMessageDrag();
	const overKey = ref<string | null>(null);

	// A drag that ends anywhere (dropped elsewhere, Esc) clears the highlight.
	watch(session, (value) => {
		if (!value) overKey.value = null;
	});

	function listeners(
		key: string,
		accepts: (drag: PostboxMessageDragSession) => boolean,
		effect: 'move' | 'copy',
		onDrop: (drag: PostboxMessageDragSession) => unknown
	) {
		const accepting = () => {
			const drag = session.value;
			return drag && accepts(drag) ? drag : null;
		};
		// Not calling preventDefault is how a row refuses a drop: the browser
		// then shows the no-drop cursor and never fires `drop` here.
		const over = (event: DragEvent) => {
			if (!accepting()) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = effect;
			overKey.value = key;
		};
		return {
			dragenter: over,
			dragover: over,
			dragleave: (event: DragEvent) => {
				// Moving between a row's own children fires leave on the row.
				const into = event.relatedTarget as Node | null;
				if (into && (event.currentTarget as Node).contains(into)) return;
				if (overKey.value === key) overKey.value = null;
			},
			drop: (event: DragEvent) => {
				const drag = accepting();
				if (!drag) return;
				event.preventDefault();
				// The source row may be hidden (and unmounted) by the move before its
				// dragend fires, so the drop closes the session itself.
				end();
				void onDrop(drag);
			},
		};
	}

	function folder(row: { _id: string; role?: string | null }) {
		return listeners(
			`folder:${row._id}`,
			(drag) => !!mailboxId.value && acceptsMessageDrop(row, drag, mailboxId.value),
			'move',
			(drag) => drag.moveTo(row._id as Id<'mailFolders'>)
		);
	}

	function label(labelId: string, apply: (messageIds: Id<'mailMessages'>[]) => unknown) {
		return listeners(
			`label:${labelId}`,
			(drag) => drag.mailboxId === mailboxId.value,
			'copy',
			(drag) => apply(drag.messageIds)
		);
	}

	return {
		/** A message drag is in flight (the rail may spring folded groups open). */
		active: computed(() => session.value !== null),
		isOverFolder: (folderId: string) => overKey.value === `folder:${folderId}`,
		isOverLabel: (labelId: string) => overKey.value === `label:${labelId}`,
		folder,
		label,
	};
}
