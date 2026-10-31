/**
 * Transactional email lifecycle — the pure half.
 *
 * Everything here decides; nothing here writes. The status and transition
 * types, the transition validator, the legal-edges graph, the effect union
 * and the reducer that turns a transition into `{ patch, effects, applied }`
 * (running the content scan of a publish inline). `lifecycle.ts` owns the
 * only code that applies that result to the database (`dispatch`), runs the
 * effects, and inserts and deletes the rows.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { AuditAction } from '../lib/auditLog';
import { defineLifecycle } from '../lib/lifecycle';
import { scanContent } from '@owlat/email-scanner';
import { throwInvalidState } from '../_utils/errors';
import type { ContentFlag, ContentScanLevel } from '@owlat/email-scanner';

// ─── Types ──────────────────────────────────────────────────────────────────

export type TransactionalEmailStatus = 'draft' | 'pending_review' | 'published';

/**
 * The `'approved' | 'rejected'` inputs are admin-driven; they resolve to
 * status patches (`published` / `draft`) inside the reducer but carry
 * distinct audit-log actions so the admin surface is identifiable.
 */
export type TransactionalEmailTransitionInput =
	| {
			to: 'published';
			at: number;
			htmlContent: string;
			htmlTranslations?: string;
			/** Set when the publish stores the caller's HTML (`publishedHtml`). */
			rendererVersion?: number;
	  }
	| { to: 'draft'; at: number }
	| { to: 'approved'; at: number }
	| { to: 'rejected'; at: number };

// ─── Validators ─────────────────────────────────────────────────────────────

export const transitionInputValidator = v.union(
	v.object({
		to: v.literal('published'),
		at: v.number(),
		htmlContent: v.string(),
		htmlTranslations: v.optional(v.string()),
		rendererVersion: v.optional(v.number()),
	}),
	v.object({ to: v.literal('draft'), at: v.number() }),
	v.object({ to: v.literal('approved'), at: v.number() }),
	v.object({ to: v.literal('rejected'), at: v.number() })
);

// ─── Legal-edges graph ──────────────────────────────────────────────────────
//
// `approved` / `rejected` resolve to statuses; the graph is keyed by the
// resolved target. The graph and the dispatcher preamble that reads it live in
// the generic lifecycle core (`lib/lifecycle.ts`); the reducers below stay
// with the email, and `lifecycle.ts` runs their effects.
// `reportsTerminalRefusals` is off — no state is terminal here and the
// published outcome union carries only `illegal_edge`.

export const TRANSACTIONAL_EMAIL_LIFECYCLE = defineLifecycle<TransactionalEmailStatus>({
	draft: ['published', 'pending_review'],
	pending_review: ['published', 'draft'],
	published: ['draft'],
});

// Map the input.to (admin actions) to the resolved persisted status.
export function resolvedTargetStatus(
	input: TransactionalEmailTransitionInput
): TransactionalEmailStatus {
	switch (input.to) {
		case 'published':
			return 'published';
		case 'draft':
			return 'draft';
		case 'approved':
			return 'published';
		case 'rejected':
			return 'draft';
	}
}

// ─── Effects ────────────────────────────────────────────────────────────────

export type Effect =
	| {
			kind: 'audit_log';
			action: AuditAction;
			emailId: Id<'transactionalEmails'>;
			userId: string;
			details: Record<string, string | number | boolean | null>;
	  }
	| {
			kind: 'record_content_scan_result';
			emailId: Id<'transactionalEmails'>;
			score: number;
			level: ContentScanLevel;
			flags: ContentFlag[];
	  }
	| {
			kind: 'update_block_usage_counts';
			previousIds: string[];
			nextIds: string[];
	  };

type ReducerResult = {
	patch: Record<string, unknown>;
	effects: Effect[];
	applied: 'transitioned' | 'recorded';
	/** Resolved target status persisted to the row. */
	resolvedTo: TransactionalEmailStatus;
};

// ─── Reducer ────────────────────────────────────────────────────────────────

export function reduce(
	email: Doc<'transactionalEmails'>,
	input: TransactionalEmailTransitionInput,
	userId: string
): ReducerResult {
	const from = email.status as TransactionalEmailStatus;
	const resolvedTo = resolvedTargetStatus(input);

	// ─── Idempotent same-state ─────────────────────────────────────────────
	// `published → published` is idempotent unless the caller passes a
	// `to: 'published'` (publish-with-scan) — that path runs the scan and
	// patches regardless. `draft → draft`, `pending_review → pending_review`
	// idempotent and just record.
	if (from === resolvedTo && input.to !== 'published') {
		return {
			patch: {},
			effects: [
				{
					kind: 'audit_log',
					action: auditActionFor(input),
					emailId: email._id,
					userId,
					details: {
						previousStatus: from,
						newStatus: resolvedTo,
						applied: 'recorded',
					},
				},
			],
			applied: 'recorded',
			resolvedTo,
		};
	}

	// ─── Publish-with-scan reducer ─────────────────────────────────────────
	if (input.to === 'published') {
		const scanResult = scanContent(email.subject, input.htmlContent);

		if (scanResult.level === 'blocked') {
			// Record scan result first (audit), then throw.
			// The throw bubbles up through dispatch; we attach scan info to
			// `data` so a consumer can surface the score/flags without parsing
			// the message.
			throwInvalidState(
				`Content blocked by our content scanner (score: ${scanResult.score}/100). ` +
					`Issues: ${scanResult.flags.map((f) => f.description).join('; ')}. ` +
					'Please review and update your content before publishing.',
				{ scanScore: scanResult.score }
			);
		}

		if (scanResult.level === 'suspicious') {
			// → pending_review. Patch htmlContent + htmlTranslations but
			// NOT status='published' or publishedAt. Audit + record scan.
			const patch: Record<string, unknown> = {
				status: 'pending_review',
				htmlContent: input.htmlContent,
				htmlTranslations: input.htmlTranslations,
				...(input.rendererVersion !== undefined && { rendererVersion: input.rendererVersion }),
				updatedAt: input.at,
			};
			// Idempotent: pending_review → pending_review is still applied
			// (the user re-uploaded content) — record as transitioned for
			// audit clarity.
			const fromForAudit = from;
			return {
				patch,
				effects: [
					{
						kind: 'audit_log',
						action: 'transactional_email.flagged_for_review',
						emailId: email._id,
						userId,
						details: {
							previousStatus: fromForAudit,
							newStatus: 'pending_review',
							score: scanResult.score,
							applied: 'transitioned',
						},
					},
					{
						kind: 'record_content_scan_result',
						emailId: email._id,
						score: scanResult.score,
						level: scanResult.level,
						flags: scanResult.flags,
					},
				],
				applied: 'transitioned',
				resolvedTo: 'pending_review',
			};
		}

		// clean → publish proper.
		return {
			patch: buildPatch(input, resolvedTo),
			effects: [
				{
					kind: 'audit_log',
					action: 'transactional_email.published',
					emailId: email._id,
					userId,
					details: {
						previousStatus: from,
						newStatus: 'published',
						applied: 'transitioned',
					},
				},
			],
			applied: 'transitioned',
			resolvedTo: 'published',
		};
	}

	// ─── Non-publish transitions ───────────────────────────────────────────
	return {
		patch: buildPatch(input, resolvedTo),
		effects: [
			{
				kind: 'audit_log',
				action: auditActionFor(input),
				emailId: email._id,
				userId,
				details: {
					previousStatus: from,
					newStatus: resolvedTo,
					applied: 'transitioned',
				},
			},
		],
		applied: 'transitioned',
		resolvedTo,
	};
}

function auditActionFor(input: TransactionalEmailTransitionInput): AuditAction {
	switch (input.to) {
		case 'published':
			return 'transactional_email.published';
		case 'draft':
			// Any `→ draft` edge is an unpublish (admin reject is a distinct
			// `→ rejected` transition, never routed here).
			return 'transactional_email.unpublished';
		case 'approved':
			return 'transactional_email.approved';
		case 'rejected':
			return 'transactional_email.rejected';
	}
}

function buildPatch(
	input: TransactionalEmailTransitionInput,
	resolvedTo: TransactionalEmailStatus
): Record<string, unknown> {
	switch (input.to) {
		case 'published': {
			// Reached only on `scanResult.level === 'clean'`.
			return {
				status: 'published',
				htmlContent: input.htmlContent,
				htmlTranslations: input.htmlTranslations,
				...(input.rendererVersion !== undefined && { rendererVersion: input.rendererVersion }),
				publishedAt: input.at,
				updatedAt: input.at,
			};
		}
		case 'draft':
			return {
				status: 'draft',
				publishedAt: undefined,
				updatedAt: input.at,
			};
		case 'approved':
			return {
				status: 'published',
				publishedAt: input.at,
				updatedAt: input.at,
			};
		case 'rejected':
			return {
				status: 'draft',
				publishedAt: undefined,
				updatedAt: input.at,
			};
	}
	// Exhaustive — TS knows the switch covers all variants.
	// `resolvedTo` is only used for tighter typing of the return-type union.
	return { status: resolvedTo };
}
