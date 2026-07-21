/**
 * A tiny tenant-scoped store for pending approvals. A real connected app would
 * back this with its own database; the reference keeps an in-memory map so the
 * behaviour is inspectable in a test. Every entry is keyed by `(organizationId,
 * id)`, so one Owlat tenant's holds can never be read or mutated through another
 * tenant's id — the same isolation rule Owlat enforces on its own side.
 */

import type { ApprovalRequest } from './approvalStore';

export interface ApprovalRepository {
	/** The request for `id` within `organizationId`, or `undefined`. */
	get(organizationId: string, id: string): ApprovalRequest | undefined;
	put(request: ApprovalRequest): void;
	delete(organizationId: string, id: string): void;
}

function scopedKey(organizationId: string, id: string): string {
	// Length-prefix the tenant so `(a, b:c)` and `(a:b, c)` can never collide.
	return `${organizationId.length}:${organizationId}:${id}`;
}

/** An in-memory {@link ApprovalRepository}. Deterministic; no I/O. */
export function createInMemoryApprovalRepository(): ApprovalRepository {
	const rows = new Map<string, ApprovalRequest>();
	return {
		get(organizationId, id) {
			const row = rows.get(scopedKey(organizationId, id));
			// Defensive: never hand back a row whose stored tenant disagrees with the
			// lookup tenant, even if a key somehow collided.
			return row && row.organizationId === organizationId ? row : undefined;
		},
		put(request) {
			rows.set(scopedKey(request.organizationId, request.id), request);
		},
		delete(organizationId, id) {
			rows.delete(scopedKey(organizationId, id));
		},
	};
}
