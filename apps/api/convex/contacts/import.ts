/**
 * Contact import (module) — batch contact ingestion composing every
 * already-deepened sub-module: **Contact resolution (module)**,
 * **Topic subscription (module)**, contact activities, DOI lifecycle's
 * admin-attest edge, and `incrementContactCount`. The single writer for
 * `contactPropertyValues` rows produced at import time, and the single
 * place that auto-registers `contactProperties` rows from integration-
 * driven imports.
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
 *
 * See docs/adr/0019-contact-import-module.md.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { resolveContact } from './resolution';
import { deduplicateContactsByEmail } from '../lib/contactHelpers';
import { incrementContactCount } from '../lib/contactCountHelpers';
import { isValidEmail, normalizeEmail, STRING_LIMITS } from '../lib/inputGuards';
import { recordContactActivity } from '../contactActivities/writer';
import { jsonPrimitiveValue } from '../lib/convexValidators';

// ─── Types ──────────────────────────────────────────────────────────────────

export const IMPORT_SOURCE_LITERALS = [
	'csv',
	'api',
	'mailchimp',
	'stripe',
] as const;

export type ImportSource = (typeof IMPORT_SOURCE_LITERALS)[number];

export type ImportRow = {
	email: string;
	firstName?: string;
	lastName?: string;
	language?: string;
	properties?: Record<string, string | number | boolean | null>;
};

export type TopicAssignments =
	| { kind: 'single'; topicId: Id<'topics'> }
	| { kind: 'per_row'; map: Record<string, Id<'topics'>[]> };

export type DoiAttest = {
	attestSource: string;
	triggeredBy?: string;
};

export type ImportOutcome = {
	imported: number;
	updated: number;
	skipped: number;
	failed: number;
	errors: string[];
	addedToTopics: number;
	propertiesSet: number;
	propertiesAutoRegistered: number;
	propertiesSkipped: number;
	activitiesRecorded: number;
};

// ─── Validators ─────────────────────────────────────────────────────────────

const importSourceValidator = v.union(
	...IMPORT_SOURCE_LITERALS.map((l) => v.literal(l)),
);

const importRowValidator = v.object({
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
	}),
);

const doiAttestValidator = v.object({
	attestSource: v.string(),
	triggeredBy: v.optional(v.string()),
});

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Maximum rows accepted in one `importBatch` call. Previously enforced only
 * on the web UI shell (`contacts/contacts.ts:importBatch`); now uniform.
 */
export const IMPORT_BATCH_MAX_ROWS = 500;

const ERROR_CAP = 50;

// ─── Internal helpers ───────────────────────────────────────────────────────

type PropertyType = 'string' | 'number' | 'boolean' | 'date';

function inferPropertyType(value: string | number | boolean): PropertyType {
	if (typeof value === 'number') return 'number';
	if (typeof value === 'boolean') return 'boolean';
	return 'string';
}

function stringifyPropertyValue(value: string | number | boolean): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	return String(value);
}

function isOperatorSource(source: ImportSource): boolean {
	return source === 'csv' || source === 'api';
}

interface PropertyCatalog {
	byKey: Map<string, Id<'contactProperties'>>;
}

async function loadPropertyCatalog(ctx: MutationCtx): Promise<PropertyCatalog> {
	const rows = await ctx.db.query('contactProperties').collect(); // bounded: custom property definitions (org-scale, few)
	const byKey = new Map<string, Id<'contactProperties'>>();
	for (const row of rows) {
		byKey.set(row.key, row._id);
	}
	return { byKey };
}

async function autoRegisterProperty(
	ctx: MutationCtx,
	catalog: PropertyCatalog,
	key: string,
	value: string | number | boolean,
	source: ImportSource,
): Promise<Id<'contactProperties'>> {
	const propertyId = await ctx.db.insert('contactProperties', {
		key,
		label: key,
		type: inferPropertyType(value),
		autoRegistered: true,
		autoRegisteredSource: source,
		createdAt: Date.now(),
	});
	catalog.byKey.set(key, propertyId);
	return propertyId;
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
	value: string,
): Promise<void> {
	const existing = await ctx.db
		.query('contactPropertyValues')
		.withIndex('by_contact_and_property', (q) =>
			q.eq('contactId', contactId).eq('propertyId', propertyId),
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
	catalog: PropertyCatalog,
): Promise<RowPropertyWriteSummary> {
	const summary: RowPropertyWriteSummary = {
		written: 0,
		autoRegistered: 0,
		skippedKeys: [],
	};
	if (!properties) return summary;

	const operatorSource = isOperatorSource(source);

	for (const [rawKey, rawValue] of Object.entries(properties)) {
		if (rawValue === undefined || rawValue === null || rawValue === '') {
			continue;
		}
		if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
			continue;
		}
		const key = rawKey.trim();
		if (!key) continue;

		let propertyId = catalog.byKey.get(key);
		if (propertyId === undefined) {
			if (operatorSource) {
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

/**
 * Build per-topic contact-id lists from the `topicAssignments` input. The
 * `single` shape produces a one-entry map keyed by the single topicId; the
 * `per_row` shape coalesces per email → topicIds.
 *
 * `subscribeMany` is called once per distinct topic — the per-call coalescing
 * keeps the `cachedMemberCount` patch to one DB write per topic.
 */
function buildPerTopicLists(
	assignments: TopicAssignments,
	contactEmailById: ReadonlyMap<Id<'contacts'>, string>,
): Map<Id<'topics'>, Id<'contacts'>[]> {
	const perTopic = new Map<Id<'topics'>, Id<'contacts'>[]>();
	if (assignments.kind === 'single') {
		const allContactIds = Array.from(contactEmailById.keys());
		if (allContactIds.length > 0) {
			perTopic.set(assignments.topicId, allContactIds);
		}
		return perTopic;
	}
	for (const [contactId, email] of contactEmailById.entries()) {
		const topicIds = assignments.map[email];
		if (!topicIds || topicIds.length === 0) continue;
		for (const topicId of topicIds) {
			const list = perTopic.get(topicId) ?? [];
			list.push(contactId);
			perTopic.set(topicId, list);
		}
	}
	return perTopic;
}

// ─── Public entry ───────────────────────────────────────────────────────────

const importBatchArgsValidator = {
	rows: v.array(importRowValidator),
	source: importSourceValidator,
	handleDuplicates: v.union(v.literal('skip'), v.literal('update')),
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
				`Cannot import more than ${IMPORT_BATCH_MAX_ROWS} contacts at once. Please split into smaller batches.`,
			);
		}

		const source = args.source;
		const mode = args.handleDuplicates === 'skip' ? 'upsert' : 'merge';

		// Within-batch dedup, keeps first occurrence.
		const { unique: deduplicatedRows, duplicateCount: withinBatchDuplicates } =
			deduplicateContactsByEmail(args.rows);

		const catalog = await loadPropertyCatalog(ctx);

		const outcome: ImportOutcome = {
			imported: 0,
			updated: 0,
			skipped: withinBatchDuplicates,
			failed: 0,
			errors: [],
			addedToTopics: 0,
			propertiesSet: 0,
			propertiesAutoRegistered: 0,
			propertiesSkipped: 0,
			activitiesRecorded: 0,
		};

		// Track keys skipped across rows so the batch-level summary line can
		// aggregate (`"Property 'COMPANY' is not registered; values dropped
		// for 5 rows."`).
		const skippedKeyCounts = new Map<string, number>();

		// Track resolved contacts (id + normalized email) for post-loop topic
		// subscription. Mailchimp/Stripe rows come in already-lowercased;
		// CSV/API may not — we always normalize before resolution.
		const resolvedByEmail = new Map<Id<'contacts'>, string>();

		const now = Date.now();

		for (const row of deduplicatedRows) {
			const normalizedEmail = row.email ? normalizeEmail(row.email) : undefined;
			if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
				outcome.failed++;
				if (outcome.errors.length < ERROR_CAP) {
					outcome.errors.push(
						`Invalid email: ${row.email ?? '(empty)'}`,
					);
				}
				continue;
			}

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

				if (action === 'created') outcome.imported++;
				else if (action === 'updated') outcome.updated++;
				else outcome.skipped++;

				// A merge that changed a built-in field must fire the
				// `contact_updated` automation trigger — the resolution module
				// surfaces the diff but does not fire triggers itself. Without
				// this, automations watching firstName/lastName/language never run
				// on CSV/integration imports.
				if (action === 'updated' && changedProperties && changedProperties.length > 0) {
					await ctx.runMutation(
						internal.automations.triggers.fireContactUpdatedTrigger,
						{ contactId, changedProperties },
					);
				}

				resolvedByEmail.set(contactId, normalizedEmail);

				const propertySummary = await applyRowProperties(
					ctx,
					contactId,
					row.properties,
					source,
					catalog,
				);
				outcome.propertiesSet += propertySummary.written;
				outcome.propertiesAutoRegistered += propertySummary.autoRegistered;
				for (const key of propertySummary.skippedKeys) {
					skippedKeyCounts.set(key, (skippedKeyCounts.get(key) ?? 0) + 1);
					outcome.propertiesSkipped++;
				}

				// Activity recording. For newly-created contacts: one `created`
				// row. For existing contacts that received property writes:
				// one `property_updated` row (aggregated across all property
				// writes for this row to avoid timeline noise).
				if (action === 'created') {
					await recordContactActivity(ctx, {
						literal: 'created',
						contactId,
						metadata: { source: 'import' },
						occurredAt: now,
					});
					outcome.activitiesRecorded++;
				} else if (propertySummary.written > 0) {
					// Use the first written key as the representative key in
					// the activity row's metadata — the row is summary-level,
					// not per-property.
					const firstKey =
						Object.keys(row.properties ?? {})
							.find((k) => {
								const v = row.properties?.[k];
								return v !== null && v !== undefined && v !== '';
							}) ?? 'properties';
					await recordContactActivity(ctx, {
						literal: 'property_updated',
						contactId,
						metadata: {
							propertyKey: firstKey,
							newValue: `${propertySummary.written} value(s) updated`,
						},
						occurredAt: now,
					});
					outcome.activitiesRecorded++;
				}

				// DOI attest — must precede topic subscription (post-loop) so
				// the contact is `'confirmed'` before subscribeMany runs.
				if (args.doiAttest) {
					await ctx.runMutation(
						internal.contacts.doiLifecycle.transition,
						{
							contactId,
							input: {
								to: 'confirmed',
								at: now,
								source: 'admin_attest',
								attestSource: args.doiAttest.attestSource,
								...(args.doiAttest.triggeredBy
									? { triggeredBy: args.doiAttest.triggeredBy }
									: {}),
							},
						},
					);
				}
			} catch (error) {
				outcome.failed++;
				if (outcome.errors.length < ERROR_CAP) {
					const message =
						error instanceof Error ? error.message : 'Unknown error';
					outcome.errors.push(
						`Failed to process ${row.email ?? '(unknown)'}: ${message}`,
					);
				}
			}
		}

		// Batch-level summary lines for skipped property keys (CSV/API only).
		for (const [key, count] of skippedKeyCounts.entries()) {
			if (outcome.errors.length >= ERROR_CAP) break;
			outcome.errors.push(
				`Property '${key}' is not registered; values dropped for ${count} row(s).`,
			);
		}

		// Per-topic subscribeMany coalescing.
		if (args.topicAssignments && resolvedByEmail.size > 0) {
			const perTopic = buildPerTopicLists(args.topicAssignments, resolvedByEmail);
			for (const [topicId, contactIds] of perTopic.entries()) {
				try {
					const result = await ctx.runMutation(
						internal.topics.subscription.subscribeMany,
						{
							topicId,
							contactIds,
							source: 'import',
							...(args.siteUrl ? { siteUrl: args.siteUrl } : {}),
						},
					);
					for (const sub of result.outcomes) {
						if (
							sub.ok &&
							(sub.action === 'subscribed' || sub.action === 'pending_doi')
						) {
							outcome.addedToTopics++;
						}
					}
				} catch (error) {
					if (outcome.errors.length < ERROR_CAP) {
						const message =
							error instanceof Error ? error.message : 'Unknown error';
						outcome.errors.push(
							`Failed to subscribe ${contactIds.length} contact(s) to topic: ${message}`,
						);
					}
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

// ─── Helper exports for shells ──────────────────────────────────────────────

// (Removed the dead CONTACTS_IMPORT_ATTEST_SCOPE + canImportAttest helper — they
// only supported a public HTTP API import shell that was never implemented; the
// two real shells gate doiAttest via session + contacts:manage. Reintroduce
// alongside a real importBatchForOrganization + requireScope if that path lands.)

/**
 * Sliced helper for typed callers — exported so the unit tests can exercise
 * the per-topic coalescing without re-deriving from outcome counters.
 */
export const __internal = {
	buildPerTopicLists,
};

// Avoid an unused import warning when `Doc` is unreferenced in the
// finalized file body (TS strict mode flags unused imports).
type _DocOnlyExport = Doc<'contacts'>;
void (null as unknown as _DocOnlyExport);
