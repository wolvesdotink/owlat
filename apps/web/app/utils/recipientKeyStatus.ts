import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';

/**
 * One recipient's PUBLIC sealing-key trust state — the non-null result of
 * `api.e2ee.recipientKeys.getRecipientKeyStatus`. Derived from the backend's
 * `returns` validator so the type is a single source of truth: the thread-level
 * trust surfaces load it ONCE and hand it to the per-contact key panel, which no
 * longer re-queries. No private key material is present in the source table, so
 * nothing secret rides in this shape.
 */
export type RecipientKeyStatus = NonNullable<
	FunctionReturnType<typeof api.e2ee.recipientKeys.getRecipientKeyStatus>
>;
