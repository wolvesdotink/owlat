/**
 * Contact import (module) — batch contact ingestion composing every already-deepened
 * sub-module: **Contact resolution (module)**, **Topic subscription (module)**, contact
 * activities, DOI lifecycle's admin-attest edge, and `incrementContactCount`. The single
 * writer for `contactPropertyValues` rows produced at import time, and the single place
 * that auto-registers `contactProperties` rows from integration-driven imports.
 *
 * Two thin shells dispatch to `importBatch`:
 *   - `contacts/contacts.ts:importBatch`  — web UI CSV upload (session + contacts:manage)
 *   - `integrationImports` (Mailchimp + Stripe processors) — sync
 *
 * Per-row ordering is load-bearing:
 *   1. Email normalize + validate
 *   2. resolveContact (mode derived from handleDuplicates)
 *   3. Property writes (source-gated catalog policy)
 *   4. recordContactActivity ('created' or 'property_updated')
 *   5. (optional) doiLifecycle.transition(admin_attest) — MUST precede
 *      step 6 so DOI-required topic memberships activate immediately
 *      rather than firing a confirmation email at subscribe time.
 *
 * After the row loop:
 *   6. Per-topic subscribeMany coalescing (one mutation call per topic)
 *   7. One incrementContactCount(ctx, imported)
 */

import { v } from 'convex/values';
import { literalUnion } from '../lib/literalUnion';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { resolveContact } from './resolution';
import { autoRegisterProperty, loadPropertyCatalog, type PropertyCatalog } from './propertyCatalog';
import { deduplicateContactsByEmail } from '../lib/contactHelpers';
import { incrementContactCount } from '../lib/contactCountHelpers';
import { STRING_LIMITS } from '../lib/inputGuards';
import { recordContactActivity } from '../contactActivities/writer';
import { jsonPrimitiveValue } from '../lib/convexValidators';
import { duplicateHandlingValidator } from '../lib/literalValidators';
import {
	buildPerTopicLists,
	countAddedToTopic,
	countResolution,
	countRowProperties,
	doiAttestInput,
	emptyImportOutcome,
	type ImportOutcome,
	noteImportError,
	noteSkippedKeys,
	rowActivity,
	rowEmail,
} from './importDecision';

// ─── Types ──────────────────────────────────────────────────────────────────

export const IMPORT_SOURCE_LITERALS = ['csv', 'api', 'mailchimp', 'stripe'] as const;

export type ImportSource = (typeof IMPORT_SOURCE_LITERALS)[number];

export type { ImportOutcome, ImportRow, TopicAssignments } from './importDecision';

// ─── Validators ─────────────────────────────────────────────────────────────

const importSourceValidator = literalUnion(IMPORT_SOURCE_LITERALS);
/** One row's shape; also the integration walker's page-commit argument. */
export const importRowValidator = v.object({
	email: v.string(),
	firstName: v.optional(v.string()),
	lastName: v.optional(v.string()),
	language: v.optional(v.string()),
	properties: v.optional(v.record(v.string(), jsonPrimitiveValue)),
});

const topicAssignmentsValidator = v.union(
	v.object({
		kind: v.literal('single'),
		topicId: v.id('topics'),
	}),
	v.object({
		kind: v.literal('per_row'),
		map: v.record(v.string(), v.array(v.id('topics'))),
	})
);

const doiAttestValidator = v.object({
	attestSource: v.string(),
	triggeredBy: v.optional(v.string()),
});

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Maximum rows accepted in one `importBatch` call, enforced here for every
 * caller, not only the web UI shell (`contacts/contacts.ts:importBatch`).
 */
const IMPORT_BATCH_MAX_ROWS = 500;

// ─── Internal helpers ───────────────────────────────────────────────────────

function stringifyPropertyValue(value: string | number | boolean): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	return String(value);
}

function isOperatorSource(source: ImportSource): boolean {
	return source === 'csv' || source === 'api';
}

/**
 * Upsert a single `contactPropertyValues` row for (contact, property). One
 * row per (contactId, propertyId) by application invariant; we patch the
 * existing row's value when one already exists.
 */
async function upsertPropertyValue(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
	propertyId: Id<'contactProperties'>,
	value: string
): Promise<void> {
	const existing = await ctx.db
		.query('contactPropertyValues')
		.withIndex('by_contact_and_property', (q) =>
			q.eq('contactId', contactId).eq('propertyId', propertyId)
		)
		.first();
	const now = Date.now();
	if (existing) {
		await ctx.db.patch(existing._id, { value, updatedAt: now });
	} else {
		await ctx.db.insert('contactPropertyValues', {
			contactId,
			propertyId,
			value,
			createdAt: now,
			updatedAt: now,
		});
	}
}

interface RowPropertyWriteSummary {
	written: number;
	autoRegistered: number;
	skippedKeys: string[];
}

async function applyRowProperties(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
	properties: Record<string, string | number | boolean | null> | undefined,
	source: ImportSource,
	catalog: PropertyCatalog
): Promise<RowPropertyWriteSummary> {
	const summary: RowPropertyWriteSummary = {
		written: 0,
		autoRegistered: 0,
		skippedKeys: [],
	};
	if (!properties) return summary;

	const operatorSource = isOperatorSource(source);

	for (const [rawKey, rawValue] of Object.entries(properties)) {
		if (rawValue == null || rawValue === '') {
			continue;
		}
		if (
			typeof rawValue !== 'string' &&
			typeof rawValue !== 'number' &&
			typeof rawValue !== 'boolean'
		) {
			continue;
		}
		const key = rawKey.trim();
		if (!key) continue;

		let propertyId = catalog.byKey.get(key);
		if (propertyId === undefined) {
			// A key whose property is being deleted is skipped, never re-registered.
			if (operatorSource || catalog.pendingDeletion.has(key)) {
				summary.skippedKeys.push(key);
				continue;
			}
			propertyId = await autoRegisterProperty(ctx, catalog, key, rawValue, source);
			summary.autoRegistered++;
		}

		const stringValue = stringifyPropertyValue(rawValue);
		if (stringValue.length > STRING_LIMITS.FORM_FIELD_VALUE) {
			// Silently skip oversized values rather than failing the row; this
			// matches Mailchimp/Stripe's tolerance for arbitrary `merge_fields`/
			// `metadata` payloads.
			continue;
		}
		await upsertPropertyValue(ctx, contactId, propertyId, stringValue);
		summary.written++;
	}

	return summary;
}

// ─── Public entry ───────────────────────────────────────────────────────────

const importBatchArgsValidator = {
	rows: v.array(importRowValidator),
	source: importSourceValidator,
	handleDuplicates: duplicateHandlingValidator,
	topicAssignments: v.optional(topicAssignmentsValidator),
	doiAttest: v.optional(doiAttestValidator),
	siteUrl: v.optional(v.string()),
};

/**
 * Single internal entry point. Returns a structured `ImportOutcome` — never
 * throws on a per-row failure (those are recorded in `errors[]`). Throws
 * only when the batch exceeds `IMPORT_BATCH_MAX_ROWS` (a programming error
 * in the calling shell, not a per-row data error).
 */
export const importBatch = internalMutation({
	args: importBatchArgsValidator,
	handler: async (ctx, args): Promise<ImportOutcome> => {
		if (args.rows.length > IMPORT_BATCH_MAX_ROWS) {
			throw new Error(
				`Cannot import more than ${IMPORT_BATCH_MAX_ROWS} contacts at once. Please split into smaller batches.`
			);
		}

		const source = args.source;
		const mode = args.handleDuplicates === 'skip' ? 'upsert' : 'merge';

		// Within-batch dedup, keeps first occurrence.
		const { unique: deduplicatedRows, duplicateCount: withinBatchDuplicates } =
			deduplicateContactsByEmail(args.rows);

		const catalog = await loadPropertyCatalog(ctx);
		let outcome = emptyImportOutcome(withinBatchDuplicates);

		// Keys skipped across rows, for one batch-level summary line per key.
		let skippedKeyCounts: ReadonlyMap<string, number> = new Map();

		// Resolved contacts (id + normalized email) for post-loop topic subscription.
		const resolvedByEmail = new Map<Id<'contacts'>, string>();

		const now = Date.now();

		for (const row of deduplicatedRows) {
			const resolved = rowEmail(row);
			if ('error' in resolved) {
				outcome.failed++;
				outcome = noteImportError(outcome, resolved.error);
				continue;
			}
			const normalizedEmail = resolved.email;

			try {
				const { contactId, action, changedProperties } = await resolveContact(ctx, {
					channel: 'email',
					identifier: normalizedEmail,
					source: 'import',
					mode,
					contactFields: {
						firstName: row.firstName,
						lastName: row.lastName,
						language: row.language,
					},
				});
				outcome = countResolution(outcome, action);

				// A merge that changed a built-in field must fire the
				// `contact_updated` automation trigger — the resolution module
				// surfaces the diff but does not fire triggers itself. Without
				// this, automations watching firstName/lastName/language never run
				// on CSV/integration imports.
				if (action === 'updated' && changedProperties && changedProperties.length > 0) {
					await ctx.runMutation(internal.automations.triggers.fireContactUpdatedTrigger, {
						contactId,
						changedProperties,
					});
				}

				resolvedByEmail.set(contactId, normalizedEmail);

				const propertySummary = await applyRowProperties(
					ctx,
					contactId,
					row.properties,
					source,
					catalog
				);
				({ outcome, skippedKeyCounts } = countRowProperties(
					outcome,
					propertySummary,
					skippedKeyCounts
				));

				const activity = rowActivity(action, row, propertySummary.written, contactId, now);
				if (activity) {
					await recordContactActivity(ctx, activity);
					outcome.activitiesRecorded++;
				}

				// DOI attest — must precede topic subscription (post-loop) so
				// the contact is `'confirmed'` before subscribeMany runs.
				if (args.doiAttest) {
					await ctx.runMutation(internal.contacts.doiLifecycle.transition, {
						contactId,
						input: doiAttestInput(args.doiAttest, now),
					});
				}
			} catch (error) {
				outcome.failed++;
				const message = error instanceof Error ? error.message : 'Unknown error';
				outcome = noteImportError(
					outcome,
					`Failed to process ${row.email ?? '(unknown)'}: ${message}`
				);
			}
		}

		// Batch-level summary lines for skipped property keys (CSV/API only).
		outcome = noteSkippedKeys(outcome, skippedKeyCounts);

		// Per-topic subscribeMany coalescing.
		if (args.topicAssignments && resolvedByEmail.size > 0) {
			const perTopic = buildPerTopicLists(args.topicAssignments, resolvedByEmail);
			for (const [topicId, contactIds] of perTopic.entries()) {
				try {
					const result = await ctx.runMutation(internal.topics.subscription.subscribeMany, {
						topicId,
						contactIds,
						source: 'import',
						...(args.siteUrl ? { siteUrl: args.siteUrl } : {}),
					});
					outcome.addedToTopics += countAddedToTopic(result.outcomes);
				} catch (error) {
					const message = error instanceof Error ? error.message : 'Unknown error';
					outcome = noteImportError(
						outcome,
						`Failed to subscribe ${contactIds.length} contact(s) to topic: ${message}`
					);
				}
			}
		}

		// Cached count increment — one call per batch, only for newly-created
		// contacts. Closes the silent drift bug where Mailchimp/Stripe imports
		// skipped this.
		if (outcome.imported > 0) {
			await incrementContactCount(ctx, outcome.imported);
		}

		return outcome;
	},
});
