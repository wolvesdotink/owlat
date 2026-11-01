/**
 * The dashboard's CSV import request (`contacts.importBatch`): its argument
 * validator, the fold of its two topic-assignment shapes into the Contact
 * import (module)'s `topicAssignments`, and the return shape the dashboard
 * reads. The registered shell in `contacts.ts` owns the auth decision and the
 * dispatch.
 */

import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import { normalizeEmail } from '../lib/inputGuards';
import { duplicateHandlingValidator } from '../lib/literalValidators';
import type { ImportOutcome, TopicAssignments } from './import';

export const importBatchArgs = {
	contacts: v.array(
		v.object({
			email: v.string(),
			firstName: v.optional(v.string()),
			lastName: v.optional(v.string()),
			language: v.optional(v.string()),
			properties: v.optional(
				v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()))
			),
		})
	),
	handleDuplicates: duplicateHandlingValidator,
	topicId: v.optional(v.id('topics')),
	contactListAssignments: v.optional(
		v.array(
			v.object({
				email: v.string(),
				topicIds: v.array(v.id('topics')),
			})
		)
	),
	// Admin-attest: imported contacts arrive already DOI-confirmed at a
	// source platform. Gated by the same `contacts:manage` permission as
	// the rest of import on this shell.
	doiAttest: v.optional(
		v.object({
			attestSource: v.string(),
		})
	),
};

// Collapse the two topic-assignment input shapes into the import
// module's `topicAssignments` discriminator.
export function collapseTopicAssignments(args: {
	topicId?: Id<'topics'>;
	contactListAssignments?: Array<{ email: string; topicIds: Id<'topics'>[] }>;
}): TopicAssignments | undefined {
	if (args.contactListAssignments && args.contactListAssignments.length > 0) {
		const map: Record<string, Id<'topics'>[]> = {};
		for (const a of args.contactListAssignments) {
			map[normalizeEmail(a.email)] = a.topicIds;
		}
		// When both topicId and per-row assignments are present, fold
		// topicId into every row's list (preserves legacy semantics).
		if (args.topicId) {
			for (const email of Object.keys(map)) {
				map[email] = [args.topicId, ...map[email]!];
			}
		}
		return { kind: 'per_row' as const, map };
	}
	if (args.topicId) {
		return { kind: 'single' as const, topicId: args.topicId };
	}
	return undefined;
}

// Preserve the legacy return shape callers expect.
export function legacyImportResult(importResult: ImportOutcome) {
	return {
		imported: importResult.imported,
		updated: importResult.updated,
		skipped: importResult.skipped,
		failed: importResult.failed,
		errors: importResult.errors,
		addedToList: importResult.addedToTopics,
		propertiesSet: importResult.propertiesSet,
		propertiesAutoRegistered: importResult.propertiesAutoRegistered,
		propertiesSkipped: importResult.propertiesSkipped,
	};
}
