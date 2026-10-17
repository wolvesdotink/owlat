/**
 * Plain-language rules (SPEC §6.1): the asynchronous compile into a
 * `mailRuleDrafts` row (`compiling` → `ready` | `failed`), the name-resolved,
 * validated preview, and confirming it into a filter with `origin` and
 * `sourceText`.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import type { Id } from '../../../_generated/dataModel';
import { api } from '../../../_generated/api';
import { enableFeatures } from '../../../__tests__/factories';
import { modules } from '../../__tests__/helpers.testlib';
import {
	compiledFilterSchema,
	previewFromCompiled,
	type CompiledFilter,
} from '../../filterCompile';
import { seedLabel, seedPersonalMailbox, seedUserFolder, type T } from './rules.testlib';
import type * as SessionOrganization from '../../../lib/sessionOrganization';

const llm = vi.hoisted(() => ({ runLlmObject: vi.fn(), output: null as unknown }));

vi.mock('../../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../../analytics/__tests__/meteredDispatch.testlib');
	return { runLlmObject: metered((opts: unknown) => llm.runLlmObject(opts)) };
});
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));

const SESSION = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
vi.mock('../../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof SessionOrganization>();
	return {
		...actual,
		requireOrgMember: vi.fn(async () => SESSION),
		getMutationContext: vi.fn(async () => SESSION),
		getBetterAuthSessionWithRole: vi.fn(async () => SESSION),
	};
});

const INVOICES: CompiledFilter = {
	name: 'Supplier invoices to Finance',
	matchType: 'all',
	conditions: [{ field: 'from', op: 'contains', value: 'supplier.example' }],
	aiQuestion: 'Is this an invoice?',
	actions: [
		{ type: 'moveToFolder', folder: 'finance' },
		{ type: 'addLabel', label: 'Unknown label' },
		{ type: 'placeInUpdates' },
	],
};

beforeEach(() => {
	llm.output = INVOICES;
	llm.runLlmObject.mockReset();
	llm.runLlmObject.mockImplementation(async () => ({
		object: llm.output,
		tokenUsage: undefined,
		modelUsed: 'stub-model',
	}));
});

async function setup(opts: { ai?: boolean; scope?: 'shared' } = {}) {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, opts.ai === false ? ['postbox'] : ['ai', 'postbox']);
	const { mailboxId, folders } = await seedPersonalMailbox(
		t,
		opts.scope ? { scope: opts.scope } : {}
	);
	const finance = await seedUserFolder(t, mailboxId, 'Finance');
	return { t, mailboxId, folders, finance };
}

async function compile(t: T, mailboxId: Id<'mailboxes'>, text = 'Supplier invoices go to Finance') {
	return await t.action(api.mail.filterCompile.compile, { mailboxId, sourceText: text });
}

describe('previewFromCompiled', () => {
	it('resolves names case-insensitively and drops unknown targets', () => {
		const preview = previewFromCompiled(compiledFilterSchema.parse(INVOICES), {
			folders: [{ id: 'f1' as Id<'mailFolders'>, name: 'Finance' }],
			labels: [],
		});
		expect(preview).toEqual({
			name: 'Supplier invoices to Finance',
			conditions: [{ field: 'from', op: 'contains', value: 'supplier.example' }],
			aiCondition: { question: 'Is this an invoice?', revision: 0 },
			actions: [{ type: 'moveToFolder', folderId: 'f1' }, { type: 'placeInUpdates' }],
		});
	});

	it('gives nothing for a rule with no usable action or no condition at all', () => {
		const targets = { folders: [], labels: [] };
		expect(
			previewFromCompiled(
				{ ...INVOICES, actions: [{ type: 'moveToFolder', folder: 'Nowhere' }] },
				targets
			)
		).toBeNull();
		expect(
			previewFromCompiled({ ...INVOICES, conditions: [], aiQuestion: null }, targets)
		).toBeNull();
	});
});

describe('compile and confirm', () => {
	it('lands a ready draft the person confirms into a plain-language filter', async () => {
		const { t, mailboxId, finance } = await setup();
		const { draftId } = await compile(t, mailboxId);
		const [draft] = await t.query(api.mail.filterCompileStore.recentDrafts, { mailboxId });
		expect(draft).toMatchObject({
			_id: draftId,
			status: 'ready',
			origin: 'plain_language',
			sourceText: 'Supplier invoices go to Finance',
		});
		expect(draft!.preview?.actions[0]).toEqual({ type: 'moveToFolder', folderId: finance });

		const filterId = await t.mutation(api.mail.filterCompileStore.confirm, { draftId });
		const filter = (await t.run(async (ctx) => await ctx.db.get(filterId)))!;
		expect(filter).toMatchObject({
			origin: 'plain_language',
			sourceText: 'Supplier invoices go to Finance',
			aiCondition: { question: 'Is this an invoice?', revision: 0 },
			revision: 0,
			stopProcessing: false,
			isEnabled: true,
		});
		expect(await t.query(api.mail.filterCompileStore.recentDrafts, { mailboxId })).toEqual([]);
		const listed = await t.query(api.mail.filters.list, { mailboxId });
		expect(listed[0]!.sourceText).toBe('Supplier invoices go to Finance');
	});

	it('fails a draft whose preview the validator refuses (a move into Trash)', async () => {
		const { t, mailboxId } = await setup();
		llm.output = { ...INVOICES, actions: [{ type: 'moveToFolder', folder: 'TRASH' }] };
		const { draftId } = await compile(t, mailboxId);
		const [draft] = await t.query(api.mail.filterCompileStore.recentDrafts, { mailboxId });
		expect(draft).toMatchObject({ _id: draftId, status: 'failed' });
		expect(draft!.preview).toBeUndefined();
		await expect(t.mutation(api.mail.filterCompileStore.confirm, { draftId })).rejects.toThrow(
			/not ready/
		);
	});

	it('fails the draft when AI is off, without a model call', async () => {
		const { t, mailboxId } = await setup({ ai: false });
		await compile(t, mailboxId);
		const [draft] = await t.query(api.mail.filterCompileStore.recentDrafts, { mailboxId });
		expect(draft!.status).toBe('failed');
		expect(llm.runLlmObject).not.toHaveBeenCalled();
	});

	it('refuses a team inbox and empty or overlong text', async () => {
		const shared = await setup({ scope: 'shared' });
		await expect(compile(shared.t, shared.mailboxId)).rejects.toThrow(/personal mailboxes/);
		const { t, mailboxId } = await setup();
		await expect(compile(t, mailboxId, '   ')).rejects.toThrow(/required/);
		await expect(compile(t, mailboxId, 'x'.repeat(501))).rejects.toThrow(/too long/);
	});

	it('discards a draft', async () => {
		const { t, mailboxId } = await setup();
		await seedLabel(t, mailboxId);
		const { draftId } = await compile(t, mailboxId);
		await t.mutation(api.mail.filterCompileStore.discard, { draftId });
		expect(await t.query(api.mail.filterCompileStore.recentDrafts, { mailboxId })).toEqual([]);
	});
});
