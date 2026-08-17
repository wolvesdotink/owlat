/**
 * Shared row model for the Review Queue's browse view. The list flattens the
 * queue items into rows carrying an `_id` (so the shared list-keyboard and
 * optimistic-hide composables, which key on `_id`, can drive the page) and the
 * card component renders them — so the type lives here where both can import it.
 */
import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';

type ReviewQueueItem = FunctionReturnType<typeof api.inbox.queries.getReviewQueue>[number];

export interface ReviewRow {
	_id: string;
	message: ReviewQueueItem['message'];
	thread: ReviewQueueItem['thread'];
}
