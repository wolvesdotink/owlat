import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { evaluateCondition, evaluateSegmentCount } from '../../conditions';
import { recordContactActivity } from '../../contactActivities/writer';

/**
 * Canonical condition shape per ADR-0004. The `kind` discriminator selects
 * the per-kind module that owns evaluation and the operator vocabulary.
 * `subscription` is reserved but not currently evaluated.
 */
type FilterCondition = {
	kind: 'contact_property' | 'email_activity' | 'topic_membership' | 'subscription';
	field?: string;
	operator: string;
	value?: string | number | boolean;
	topicId?: string;
};

const modules = import.meta.glob('../../**/*.*s');

describe('evaluateCondition', () => {
	describe('contact_property - built-in fields', () => {
		it('matches built-in email field with equals', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					firstName: 'Alice',
					lastName: 'Smith',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const condition: FilterCondition = {
					kind: 'contact_property',
					field: 'email',
					operator: 'equals',
					value: 'alice@example.com',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(true);
			});
		});

		it('matches built-in firstName field with contains', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					firstName: 'Alice',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const condition: FilterCondition = {
					kind: 'contact_property',
					field: 'firstName',
					operator: 'contains',
					value: 'lic',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(true);
			});
		});

		it('returns false when built-in field does not match', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const condition: FilterCondition = {
					kind: 'contact_property',
					field: 'email',
					operator: 'equals',
					value: 'bob@example.com',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(false);
			});
		});

		it('matches lastName field with not_equals', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					lastName: 'Smith',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const condition: FilterCondition = {
					kind: 'contact_property',
					field: 'lastName',
					operator: 'not_equals',
					value: 'Jones',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(true);
			});
		});

		it('matches source field with equals', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'import',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const condition: FilterCondition = {
					kind: 'contact_property',
					field: 'source',
					operator: 'equals',
					value: 'import',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(true);
			});
		});

		it('evaluates is_empty for missing optional field', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const condition: FilterCondition = {
					kind: 'contact_property',
					field: 'firstName',
					operator: 'is_empty',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(true);
			});
		});
	});

	describe('contact_property - custom fields', () => {
		it('matches custom property value', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const propertyId = await ctx.db.insert('contactProperties', {
					key: 'company',
					label: 'Company',
					type: 'string',
					createdAt: Date.now(),
				});

				await ctx.db.insert('contactPropertyValues', {
					contactId,
					propertyId,
					value: 'Acme Corp',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});

				const condition: FilterCondition = {
					kind: 'contact_property',
					field: 'company',
					operator: 'equals',
					value: 'Acme Corp',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(true);
			});
		});

		it('returns false for missing custom property', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const condition: FilterCondition = {
					kind: 'contact_property',
					field: 'nonexistent',
					operator: 'equals',
					value: 'anything',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(false);
			});
		});

		it('returns false when custom property exists but value does not match', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const propertyId = await ctx.db.insert('contactProperties', {
					key: 'company',
					label: 'Company',
					type: 'string',
					createdAt: Date.now(),
				});

				await ctx.db.insert('contactPropertyValues', {
					contactId,
					propertyId,
					value: 'Acme Corp',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});

				const condition: FilterCondition = {
					kind: 'contact_property',
					field: 'company',
					operator: 'equals',
					value: 'Other Corp',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(false);
			});
		});

		it('matches custom property with contains operator', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const propertyId = await ctx.db.insert('contactProperties', {
					key: 'company',
					label: 'Company',
					type: 'string',
					createdAt: Date.now(),
				});

				await ctx.db.insert('contactPropertyValues', {
					contactId,
					propertyId,
					value: 'Acme Corporation',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});

				const condition: FilterCondition = {
					kind: 'contact_property',
					field: 'company',
					operator: 'contains',
					value: 'acme',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(true);
			});
		});

		it('is_empty for custom property with no value set', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				await ctx.db.insert('contactProperties', {
					key: 'company',
					label: 'Company',
					type: 'string',
					createdAt: Date.now(),
				});

				// No contactPropertyValues inserted

				const condition: FilterCondition = {
					kind: 'contact_property',
					field: 'company',
					operator: 'is_empty',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(true);
			});
		});
	});

	describe('topic_membership', () => {
		it('returns true when contact is in the list (equals)', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const listId = await ctx.db.insert('topics', {
					name: 'Newsletter',
					createdAt: Date.now(),
				});

				await ctx.db.insert('contactTopics', {
					contactId,
					topicId: listId,
					addedAt: Date.now(),
				});

				const condition: FilterCondition = {
					kind: 'topic_membership',
					operator: 'equals',
					topicId: listId,
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(true);
			});
		});

		it('returns false when contact is not in the list (equals)', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const listId = await ctx.db.insert('topics', {
					name: 'Newsletter',
					createdAt: Date.now(),
				});

				// Contact not added to list

				const condition: FilterCondition = {
					kind: 'topic_membership',
					operator: 'equals',
					topicId: listId,
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(false);
			});
		});

		it('returns true when contact is not in the list (not_equals)', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const listId = await ctx.db.insert('topics', {
					name: 'Newsletter',
					createdAt: Date.now(),
				});

				const condition: FilterCondition = {
					kind: 'topic_membership',
					operator: 'not_equals',
					topicId: listId,
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(true);
			});
		});

		it('returns false when contact is in the list (not_equals)', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const listId = await ctx.db.insert('topics', {
					name: 'Newsletter',
					createdAt: Date.now(),
				});

				await ctx.db.insert('contactTopics', {
					contactId,
					topicId: listId,
					addedAt: Date.now(),
				});

				const condition: FilterCondition = {
					kind: 'topic_membership',
					operator: 'not_equals',
					topicId: listId,
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(false);
			});
		});

		it('returns false when list value is empty', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const condition: FilterCondition = {
					kind: 'topic_membership',
					operator: 'equals',
					topicId: '',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(false);
			});
		});
	});

	describe('email_activity', () => {
		it('returns true when contact has activity (is_true)', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});

				// Recording the open through the real writer denormalizes
				// `hasOpened` onto the contact, which the condition reads.
				await recordContactActivity(ctx, {
					literal: 'email_opened',
					contactId,
					metadata: {},
				});
				const contact = (await ctx.db.get(contactId))!;

				const condition: FilterCondition = {
					kind: 'email_activity',
					field: 'opened',
					operator: 'is_true',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(true);
			});
		});

		it('returns false when contact has no activity (is_true)', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const condition: FilterCondition = {
					kind: 'email_activity',
					field: 'opened',
					operator: 'is_true',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(false);
			});
		});

		it('returns true when contact has no activity (is_false)', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const condition: FilterCondition = {
					kind: 'email_activity',
					field: 'clicked',
					operator: 'is_false',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(true);
			});
		});

		it('returns false when contact has activity (is_false)', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});

				// Recording the click through the real writer denormalizes
				// `hasClicked` onto the contact, which the condition reads.
				await recordContactActivity(ctx, {
					literal: 'email_clicked',
					contactId,
					metadata: {},
				});
				const contact = (await ctx.db.get(contactId))!;

				const condition: FilterCondition = {
					kind: 'email_activity',
					field: 'clicked',
					operator: 'is_false',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(false);
			});
		});

		it('differentiates between email activity types', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				// Only email_sent activity, not email_opened
				await ctx.db.insert('contactActivities', {
					contactId,
					activityType: 'email_sent',
					metadata: {},
					occurredAt: Date.now(),
				});

				const condition: FilterCondition = {
					kind: 'email_activity',
					field: 'opened',
					operator: 'is_true',
				};

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(false);
			});
		});
	});

	describe('unknown condition type', () => {
		it('returns false for unknown type', async () => {
			const t = convexTest(schema, modules);

			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', {
					email: 'alice@example.com',
					source: 'api',
					doiStatus: 'not_required',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const contact = (await ctx.db.get(contactId))!;

				const condition = {
					type: 'unknown_type',
					operator: 'equals',
					value: 'test',
				} as unknown as FilterCondition;

				const result = await evaluateCondition(ctx, condition, contact);
				expect(result).toBe(false);
			});
		});
	});
});

describe('evaluateSegmentCount', () => {
	it('returns all contacts when no conditions are specified', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'alice@example.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contacts', {
				email: 'bob@example.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contacts', {
				email: 'charlie@example.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const result = await evaluateSegmentCount(
				ctx,
				JSON.stringify({ logic: 'AND', conditions: [] })
			);

			expect(result).toEqual({ total: 3, eligible: 3 });
		});
	});

	it('excludes soft-deleted contacts from the count (ADR-0033)', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'live@example.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contacts', {
				email: 'deleted@example.com',
				source: 'api',
				doiStatus: 'not_required',
				deletedAt: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const result = await evaluateSegmentCount(
				ctx,
				JSON.stringify({ logic: 'AND', conditions: [] })
			);

			// Only the live contact counts — the soft-deleted one is filtered.
			expect(result).toEqual({ total: 1, eligible: 1 });
		});
	});

	it('returns 0 for invalid JSON filters', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'alice@example.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const result = await evaluateSegmentCount(ctx, 'invalid json{{{');
			expect(result).toEqual({ total: 0, eligible: 0 });
		});
	});

	it('filters contacts with AND logic', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'alice@acme.com',
				firstName: 'Alice',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contacts', {
				email: 'bob@acme.com',
				firstName: 'Bob',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contacts', {
				email: 'charlie@other.com',
				firstName: 'Charlie',
				source: 'import',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const filters = {
				logic: 'AND',
				conditions: [
					{
						kind: 'contact_property',
						field: 'email',
						operator: 'contains',
						value: 'acme.com',
					},
					{
						kind: 'contact_property',
						field: 'source',
						operator: 'equals',
						value: 'api',
					},
				],
			};

			const result = await evaluateSegmentCount(ctx, JSON.stringify(filters));
			expect(result).toEqual({ total: 2, eligible: 2 });
		});
	});

	it('filters contacts with OR logic', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'alice@acme.com',
				firstName: 'Alice',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contacts', {
				email: 'bob@other.com',
				firstName: 'Bob',
				source: 'import',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contacts', {
				email: 'charlie@other.com',
				firstName: 'Charlie',
				source: 'form',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const filters = {
				logic: 'OR',
				conditions: [
					{
						kind: 'contact_property',
						field: 'email',
						operator: 'contains',
						value: 'acme.com',
					},
					{
						kind: 'contact_property',
						field: 'source',
						operator: 'equals',
						value: 'import',
					},
				],
			};

			const result = await evaluateSegmentCount(ctx, JSON.stringify(filters));
			expect(result).toEqual({ total: 2, eligible: 2 });
		});
	});

	it('returns total equal to eligible for segments', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'alice@acme.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const filters = {
				logic: 'AND',
				conditions: [
					{
						kind: 'contact_property',
						field: 'email',
						operator: 'contains',
						value: 'acme',
					},
				],
			};

			const result = await evaluateSegmentCount(ctx, JSON.stringify(filters));
			expect(result.total).toBe(result.eligible);
		});
	});

	it('AND logic requires all conditions to match', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			// This contact matches email but NOT source
			await ctx.db.insert('contacts', {
				email: 'alice@acme.com',
				source: 'import',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const filters = {
				logic: 'AND',
				conditions: [
					{
						kind: 'contact_property',
						field: 'email',
						operator: 'contains',
						value: 'acme.com',
					},
					{
						kind: 'contact_property',
						field: 'source',
						operator: 'equals',
						value: 'api',
					},
				],
			};

			const result = await evaluateSegmentCount(ctx, JSON.stringify(filters));
			expect(result).toEqual({ total: 0, eligible: 0 });
		});
	});

	it('OR logic matches if any condition is true', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			// This contact matches only the source condition, not email
			await ctx.db.insert('contacts', {
				email: 'alice@other.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const filters = {
				logic: 'OR',
				conditions: [
					{
						kind: 'contact_property',
						field: 'email',
						operator: 'contains',
						value: 'acme.com',
					},
					{
						kind: 'contact_property',
						field: 'source',
						operator: 'equals',
						value: 'api',
					},
				],
			};

			const result = await evaluateSegmentCount(ctx, JSON.stringify(filters));
			expect(result).toEqual({ total: 1, eligible: 1 });
		});
	});

	it('handles topic_membership conditions in segment evaluation', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const contactId1 = await ctx.db.insert('contacts', {
				email: 'alice@example.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contacts', {
				email: 'bob@example.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const listId = await ctx.db.insert('topics', {
				name: 'Newsletter',
				createdAt: Date.now(),
			});

			await ctx.db.insert('contactTopics', {
				contactId: contactId1,
				topicId: listId,
				addedAt: Date.now(),
			});

			const filters = {
				logic: 'AND',
				conditions: [
					{
						kind: 'topic_membership',
						operator: 'equals',
						topicId: listId,
					},
				],
			};

			const result = await evaluateSegmentCount(ctx, JSON.stringify(filters));
			expect(result).toEqual({ total: 1, eligible: 1 });
		});
	});

	it('returns 0 when no contacts match any conditions', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'alice@example.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const filters = {
				logic: 'AND',
				conditions: [
					{
						kind: 'contact_property',
						field: 'email',
						operator: 'equals',
						value: 'nonexistent@example.com',
					},
				],
			};

			const result = await evaluateSegmentCount(ctx, JSON.stringify(filters));
			expect(result).toEqual({ total: 0, eligible: 0 });
		});
	});
});
