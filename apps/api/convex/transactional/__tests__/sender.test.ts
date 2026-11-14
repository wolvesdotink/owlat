/**
 * Setting the transactional sender (`transactional/sender.ts`): the instance
 * setting and a template's own sender are refused unless the address is on a
 * verified sending domain, need their neighbours' permission floors, are
 * audited, and are what `get` resolves.
 */
import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionOrganizationModule from '../../lib/sessionOrganization';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	createTestDomain,
	createTestInstanceSettings,
	createTestTransactionalEmail,
} from '../../__tests__/factories';

const roleMock = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'admin' | 'editor' | 'member' }));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganizationModule>(
		'../../lib/sessionOrganization'
	);
	const session = () => ({ userId: 'user-a', role: roleMock.role });
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => session()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('user-a'),
		getMutationContext: vi.fn().mockImplementation(async () => session()),
	};
});

// `'../../**'` from here omits the sibling `transactional/*` modules; merge a
// glob rooted at `transactional/` with its keys re-prefixed.
const transactionalGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../transactional/'),
		mod,
	])
);
const modules = { ...import.meta.glob('../../**/*.*s'), ...transactionalGlob };

beforeEach(() => {
	roleMock.role = 'owner';
});

async function seed(t: ReturnType<typeof convexTest>): Promise<Id<'transactionalEmails'>> {
	return await t.run(async (ctx) => {
		for (const [domain, status] of [
			['example.com', 'verified'],
			['mail.example.com', 'verified'],
			['news.example.com', 'pending'],
		] as const) {
			await ctx.db.insert(
				'domains',
				createTestDomain({ domain, status, lastVerifiedAt: Date.now() })
			);
		}
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({
				defaultFromEmail: 'hello@example.com',
				defaultFromName: 'Example',
			})
		);
		return await ctx.db.insert(
			'transactionalEmails',
			createTestTransactionalEmail({ status: 'published' })
		);
	});
}

describe('transactional.sender.setInstanceSender', () => {
	it('saves a sender on a verified domain, audits it, and resolves to it', async () => {
		const t = convexTest(schema, modules);
		await seed(t);

		await t.mutation(api.transactional.sender.setInstanceSender, {
			sender: { email: ' account@mail.example.com ', name: 'Example Accounts' },
		});

		const state = await t.query(api.transactional.sender.get, {});
		expect(state.resolved).toEqual({
			address: 'account@mail.example.com',
			name: 'Example Accounts',
			source: 'transactional',
			isDomainVerified: true,
		});
		expect(state.transactional).toEqual({
			email: 'account@mail.example.com',
			name: 'Example Accounts',
		});
		const audit = await t.run(async (ctx) => await ctx.db.query('auditLogs').collect());
		expect(audit.map((row) => row.action)).toEqual(['settings.transactional_sender_updated']);
		expect(JSON.parse(audit[0]!.detailsBlob!)).toEqual({
			from: null,
			to: { email: 'account@mail.example.com', name: 'Example Accounts' },
		});
	});

	it('refuses an address on an unverified or unknown domain, naming the domain', async () => {
		const t = convexTest(schema, modules);
		await seed(t);

		await expect(
			t.mutation(api.transactional.sender.setInstanceSender, {
				sender: { email: 'hello@news.example.com' },
			})
		).rejects.toThrow(/news\.example\.com is not verified yet/);
		await expect(
			t.mutation(api.transactional.sender.setInstanceSender, {
				sender: { email: 'hello@elsewhere.example' },
			})
		).rejects.toThrow(/elsewhere\.example is not one of your sending domains/);

		const settings = await t.run(async (ctx) => await ctx.db.query('instanceSettings').first());
		expect(settings?.transactionalFromEmail).toBeUndefined();
	});

	it('refuses a display name that would break the From header', async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await expect(
			t.mutation(api.transactional.sender.setInstanceSender, {
				sender: { email: 'account@mail.example.com', name: 'Accounts\r\nBcc: x@y.test' },
			})
		).rejects.toThrow(/one line/);
	});

	it('clears back to the default sender', async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await t.mutation(api.transactional.sender.setInstanceSender, {
			sender: { email: 'account@mail.example.com' },
		});
		await t.mutation(api.transactional.sender.setInstanceSender, { sender: null });

		const state = await t.query(api.transactional.sender.get, {});
		expect(state.transactional).toBeNull();
		expect(state.resolved).toMatchObject({ address: 'hello@example.com', source: 'default' });
	});

	it('lets an editor read the sender but not change it', async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		roleMock.role = 'editor';

		await expect(
			t.mutation(api.transactional.sender.setInstanceSender, {
				sender: { email: 'account@mail.example.com' },
			})
		).rejects.toThrow(/Only owners and admins/);
		const state = await t.query(api.transactional.sender.get, {});
		expect(state.canManageInstance).toBe(false);
		expect(state.resolved.address).toBe('hello@example.com');
	});

	it('suggests the transactional subdomain of the stream layout', async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const state = await t.query(api.transactional.sender.get, {});
		expect(state.suggestedDomain).toBe('mail.example.com');
		expect(state.sendingDomains).toEqual([
			{ domain: 'example.com', isVerified: true },
			{ domain: 'mail.example.com', isVerified: true },
			{ domain: 'news.example.com', isVerified: false },
		]);
	});
});

describe('transactional.sender.setTemplateSender', () => {
	it("overrides one template's sender and goes back to the transactional sender", async () => {
		const t = convexTest(schema, modules);
		const templateId = await seed(t);
		await t.mutation(api.transactional.sender.setInstanceSender, {
			sender: { email: 'account@mail.example.com' },
		});

		await t.mutation(api.transactional.sender.setTemplateSender, {
			id: templateId,
			sender: { email: 'receipts@mail.example.com', name: 'Example Billing' },
		});
		const overridden = await t.query(api.transactional.sender.get, { templateId });
		expect(overridden.resolved).toMatchObject({
			address: 'receipts@mail.example.com',
			name: 'Example Billing',
			source: 'template',
		});
		expect(overridden.inherited).toMatchObject({
			address: 'account@mail.example.com',
			source: 'transactional',
		});

		await t.mutation(api.transactional.sender.setTemplateSender, { id: templateId, sender: null });
		const restored = await t.query(api.transactional.sender.get, { templateId });
		expect(restored.template).toBeNull();
		expect(restored.resolved).toMatchObject({
			address: 'account@mail.example.com',
			source: 'transactional',
		});
		const actions = await t.run(async (ctx) =>
			(await ctx.db.query('auditLogs').collect()).map((row) => row.action)
		);
		expect(actions.filter((a) => a === 'transactional_email.sender_updated')).toHaveLength(2);
	});

	it('refuses an unverified domain and leaves the template as it was', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seed(t);
		await expect(
			t.mutation(api.transactional.sender.setTemplateSender, {
				id: templateId,
				sender: { email: 'receipts@news.example.com' },
			})
		).rejects.toThrow(/news\.example\.com is not verified yet/);
		const template = await t.run(async (ctx) => await ctx.db.get(templateId));
		expect(template?.fromEmail).toBeUndefined();
	});

	it('refuses a member without the template-management permission', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seed(t);
		roleMock.role = 'editor';
		await expect(
			t.mutation(api.transactional.sender.setTemplateSender, {
				id: templateId,
				sender: { email: 'receipts@mail.example.com' },
			})
		).rejects.toThrow(/Only owners and admins/);
	});
});
