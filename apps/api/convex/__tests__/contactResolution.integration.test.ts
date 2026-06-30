/**
 * Integration tests for Contact resolution (module).
 *
 * Covers the find-or-create primitive across the three modes (strict, upsert,
 * merge), the soft-delete-skip invariant, and the identity-cascade-at-
 * soft-delete contract that makes identifiers reclaimable on day 1.
 *
 * See docs/adr/0008-contact-resolution-module.md.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { softDeleteContact } from '../lib/contactMutations';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
		decrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') &&
		!path.includes('agentSecurity') &&
		!path.includes('agentContext') &&
		!path.includes('agentClassifier') &&
		!path.includes('agentDrafter') &&
		!path.includes('agentRouter') &&
		!path.includes('agent/walker') &&
		!path.includes('agent/steps/index') &&
		!path.includes('agent/steps/shared') &&
		!path.includes('agent/steps/classify') &&
		!path.includes('agent/steps/draft') &&
		!path.includes('knowledgeExtraction') &&
		!path.includes('semanticFileProcessing') &&
		!path.includes('visualizationAgent') &&
		!path.includes('llmProvider')
	)
);

// ============================================================
// upsert mode
// ============================================================

describe('resolveContact — upsert mode', () => {
	it('creates a new Contact + email identity row on first call', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'first@example.com',
			source: 'inbound',
			mode: 'upsert',
			contactFields: { firstName: 'Ada' },
		});

		expect(result.action).toBe('created');
		expect(result.contactId).toBeDefined();

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(result.contactId);
			expect(contact?.email).toBe('first@example.com');
			expect(contact?.firstName).toBe('Ada');
			expect(contact?.source).toBe('inbound');
			expect(contact?.searchableText).toContain('first@example.com');
			expect(contact?.searchableText).toContain('ada');

			// Identity row must exist
			const identity = await ctx.db
				.query('contactIdentities')
				.withIndex('by_identifier', (q) =>
					q.eq('channel', 'email').eq('identifier', 'first@example.com')
				)
				.first();
			expect(identity?.contactId).toBe(result.contactId);
			expect(identity?.isPrimary).toBe(true);
		});
	});

	it('returns matched contactId without touching fields on second call', async () => {
		const t = convexTest(schema, modules);

		const first = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'match@example.com',
			source: 'inbound',
			mode: 'upsert',
			contactFields: { firstName: 'Alice' },
		});

		const second = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'match@example.com',
			source: 'inbound',
			mode: 'upsert',
			contactFields: { firstName: 'WRONG' }, // upsert must not overwrite
		});

		expect(second.action).toBe('matched');
		expect(second.contactId).toBe(first.contactId);

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(first.contactId);
			expect(contact?.firstName).toBe('Alice'); // not overwritten
		});
	});

	it('creates Contact without `email` when channel is sms', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'sms',
			identifier: '+15551234567',
			source: 'inbound',
			mode: 'upsert',
		});

		expect(result.action).toBe('created');

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(result.contactId);
			expect(contact?.email).toBeUndefined();
			expect(contact?.source).toBe('inbound');

			const identity = await ctx.db
				.query('contactIdentities')
				.withIndex('by_identifier', (q) =>
					q.eq('channel', 'sms').eq('identifier', '+15551234567')
				)
				.first();
			expect(identity?.contactId).toBe(result.contactId);
		});
	});

	it('normalizes email identifier to lowercase', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'MixedCase@Example.COM',
			source: 'api',
			mode: 'upsert',
		});

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(result.contactId);
			expect(contact?.email).toBe('mixedcase@example.com');
		});

		// Subsequent lookup with different casing matches
		const second = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'MIXEDCASE@example.com',
			source: 'api',
			mode: 'upsert',
		});
		expect(second.action).toBe('matched');
		expect(second.contactId).toBe(result.contactId);
	});

	it('does NOT normalize phone identifier to lowercase', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'sms',
			identifier: '+15551234',
			source: 'inbound',
			mode: 'upsert',
		});

		await t.run(async (ctx) => {
			const identity = await ctx.db
				.query('contactIdentities')
				.withIndex('by_identifier', (q) =>
					q.eq('channel', 'sms').eq('identifier', '+15551234')
				)
				.first();
			expect(identity?.contactId).toBe(result.contactId);
		});
	});
});

// ============================================================
// strict mode
// ============================================================

describe('resolveContact — strict mode', () => {
	it('creates a new Contact on first call', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'strict@example.com',
			source: 'api',
			mode: 'strict',
		});

		expect(result.action).toBe('created');
	});

	it('throws ALREADY_EXISTS when contact already exists', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'duplicate@example.com',
			source: 'api',
			mode: 'strict',
		});

		await expect(
			t.mutation(internal.contacts.resolution.resolve, {
				channel: 'email',
				identifier: 'duplicate@example.com',
				source: 'api',
				mode: 'strict',
			})
		).rejects.toThrow(/already exists/i);
	});
});

// ============================================================
// merge mode
// ============================================================

describe('resolveContact — merge mode', () => {
	it('creates a new Contact on first call', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'merge@example.com',
			source: 'import',
			mode: 'merge',
			contactFields: { firstName: 'Bob' },
		});

		expect(result.action).toBe('created');
	});

	it('patches non-empty fields on match and returns action=updated', async () => {
		const t = convexTest(schema, modules);

		const first = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'patchme@example.com',
			source: 'import',
			mode: 'merge',
			contactFields: { firstName: 'Bob', lastName: 'Original' },
		});

		const second = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'patchme@example.com',
			source: 'import',
			mode: 'merge',
			contactFields: { firstName: 'Robert' }, // last name unchanged
		});

		expect(second.action).toBe('updated');
		expect(second.contactId).toBe(first.contactId);

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(first.contactId);
			expect(contact?.firstName).toBe('Robert');
			expect(contact?.lastName).toBe('Original'); // preserved
			expect(contact?.searchableText).toContain('robert');
		});
	});

	it('surfaces the changedProperties diff so callers can fire contact_updated', async () => {
		const t = convexTest(schema, modules);

		const first = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'diff@example.com',
			source: 'import',
			mode: 'merge',
			contactFields: { firstName: 'Bob', lastName: 'Original', language: 'en' },
		});

		const second = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'diff@example.com',
			source: 'import',
			mode: 'merge',
			// firstName + language change, lastName unchanged.
			contactFields: { firstName: 'Robert', lastName: 'Original', language: 'de' },
		});

		expect(second.action).toBe('updated');
		expect(second.contactId).toBe(first.contactId);
		expect(second.changedProperties).toEqual(['firstName', 'language']);
	});

	it('omits changedProperties when nothing changed', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'nodiff@example.com',
			source: 'import',
			mode: 'merge',
			contactFields: { firstName: 'Same' },
		});

		const second = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'nodiff@example.com',
			source: 'import',
			mode: 'merge',
			contactFields: { firstName: 'Same' },
		});

		expect(second.action).toBe('matched');
		expect(second.changedProperties).toBeUndefined();
	});

	it('returns action=matched when merge has nothing to update', async () => {
		const t = convexTest(schema, modules);

		const first = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'nochange@example.com',
			source: 'import',
			mode: 'merge',
			contactFields: { firstName: 'Same' },
		});

		const second = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'nochange@example.com',
			source: 'import',
			mode: 'merge',
			contactFields: { firstName: 'Same' },
		});

		expect(second.action).toBe('matched');
		expect(second.contactId).toBe(first.contactId);
	});

	it('does NOT overwrite existing fields when merge value is empty', async () => {
		const t = convexTest(schema, modules);

		const first = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'noempty@example.com',
			source: 'import',
			mode: 'merge',
			contactFields: { firstName: 'Original' },
		});

		const second = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'noempty@example.com',
			source: 'import',
			mode: 'merge',
			contactFields: { firstName: '   ' }, // whitespace-only counts as empty
		});

		expect(second.action).toBe('matched'); // no change

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(first.contactId);
			expect(contact?.firstName).toBe('Original');
		});
	});
});

// ============================================================
// Soft-delete invariants
// ============================================================

describe('resolveContact — soft-delete cascade', () => {
	it('skips soft-deleted contacts and creates new', async () => {
		const t = convexTest(schema, modules);

		const first = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'recycled@example.com',
			source: 'api',
			mode: 'upsert',
		});

		// Soft-delete via the canonical helper (which cascades identities)
		await t.run(async (ctx) => {
			await softDeleteContact(ctx, first.contactId, 'test');
		});

		// Identity row should be gone
		await t.run(async (ctx) => {
			const identity = await ctx.db
				.query('contactIdentities')
				.withIndex('by_identifier', (q) =>
					q.eq('channel', 'email').eq('identifier', 'recycled@example.com')
				)
				.first();
			expect(identity).toBeNull();
		});

		// A fresh resolve for the same identifier creates a NEW Contact
		const second = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'recycled@example.com',
			source: 'api',
			mode: 'upsert',
		});

		expect(second.action).toBe('created');
		expect(second.contactId).not.toBe(first.contactId);

		await t.run(async (ctx) => {
			const oldContact = await ctx.db.get(first.contactId);
			expect(oldContact?.deletedAt).toBeTypeOf('number');
			const newContact = await ctx.db.get(second.contactId);
			expect(newContact?.deletedAt).toBeUndefined();
		});
	});

	it('strict mode does not throw when the only match is soft-deleted', async () => {
		const t = convexTest(schema, modules);

		const first = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'strict-recycled@example.com',
			source: 'api',
			mode: 'strict',
		});

		await t.run(async (ctx) => {
			await softDeleteContact(ctx, first.contactId, 'test');
		});

		const second = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'email',
			identifier: 'strict-recycled@example.com',
			source: 'api',
			mode: 'strict',
		});

		expect(second.action).toBe('created');
		expect(second.contactId).not.toBe(first.contactId);
	});
});

// ============================================================
// Channel uniqueness
// ============================================================

describe('resolveContact — channel isolation', () => {
	it('treats same identifier on different channels as different identities', async () => {
		const t = convexTest(schema, modules);

		const sms = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'sms',
			identifier: '+15551234',
			source: 'inbound',
			mode: 'upsert',
		});

		const whatsapp = await t.mutation(internal.contacts.resolution.resolve, {
			channel: 'whatsapp',
			identifier: '+15551234',
			source: 'inbound',
			mode: 'upsert',
		});

		// Both created — separate Contacts, channel is part of the key.
		expect(sms.action).toBe('created');
		expect(whatsapp.action).toBe('created');
		expect(sms.contactId).not.toBe(whatsapp.contactId);
	});
});
