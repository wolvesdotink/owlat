import type { Id } from '@owlat/api/dataModel';
import { ref } from 'vue';

/**
 * Read-on-arrival undos still running on the server (more pages, or a sender
 * re-sort chain), app-wide: whichever component started one may be gone before
 * it finishes. `PostboxArrivalUndoHost` (mounted in app.vue while this is not
 * empty) subscribes to each and announces its outcome.
 *
 * A leaf of its own because app.vue reads it on every page: the undo itself
 * (`composables/postbox/usePostboxArrivalUndo.ts`) and the host load only once
 * an undo is pending.
 */
export const pendingArrivalUndos = ref<Id<'mailArrivalOperations'>[]>([]);
