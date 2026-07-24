import type { Doc, Id } from '../../_generated/dataModel';
import type { Effect } from './effects';

// ============================================================================
// Send lifecycle — shared types.
//
// The public type vocabulary (Send, SendRef, Send status) referenced across the
// reducers / effects / lookups / dispatcher, plus the per-table Doc aliases and
// the reducer's `{ patch, effects, applied }` output shape. See CONTEXT.md
// "Send lifecycle". Kept ctx-free and dependency-light so reducers stay
// directly unit-testable.
// ============================================================================

export type SendKind = 'campaign' | 'transactional';

export type SendRef =
	| { kind: 'campaign'; id: Id<'emailSends'> }
	| { kind: 'transactional'; id: Id<'transactionalSends'> };

export type SendStatus =
	| 'queued'
	| 'sent'
	| 'failed'
	| 'delivered'
	| 'opened'
	| 'clicked'
	| 'bounced'
	| 'complained';

export type TransitionInput =
	| { to: 'sent'; at: number; providerMessageId: string; providerType?: string }
	| { to: 'failed'; at: number; errorMessage: string; errorCode: string }
	| { to: 'delivered'; at: number }
	| { to: 'opened'; at: number }
	| { to: 'clicked'; at: number; url: string }
	| {
			to: 'bounced';
			at: number;
			bounceType: 'hard' | 'soft';
			bounceMessage?: string;
	  }
	| { to: 'complained'; at: number };

export type TransitionOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded' | 'duplicate';
			from: SendStatus;
			to: SendStatus;
			contactEmail: string;
	  }
	| {
			ok: false;
			reason: 'send_not_found' | 'illegal_edge' | 'invalid_for_kind' | 'terminal';
			from?: SendStatus;
			to?: SendStatus;
	  };

export type EmailSendDoc = Doc<'emailSends'>;
export type TransactionalSendDoc = Doc<'transactionalSends'>;

export type ReducerResult = {
	patch: Record<string, unknown>;
	effects: Effect[];
	applied: 'transitioned' | 'recorded' | 'duplicate';
	from: SendStatus;
	to: SendStatus;
};

/**
 * Test previews need the durable lifecycle for authenticated routing re-entry,
 * but must not become customer/product telemetry or recipient suppression.
 * Keep the patch/status evidence and erase only the declarative side effects.
 */
export function withoutTestSendEffects<T extends { effects: Effect[] }>(
	send: EmailSendDoc | TransactionalSendDoc,
	ref: SendRef,
	result: T
): T {
	return ref.kind === 'transactional' && (send as TransactionalSendDoc).kind === 'test'
		? { ...result, effects: [] }
		: result;
}
