import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { createTestCodeWorkTask, enableFeatures } from './factories';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({ subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' }),
	};
});

vi.mock('../lib/posthogHelpers', async () => ({
	trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') && !path.includes('agentSecurity') && !path.includes('agentContext') && !path.includes('agentClassifier') && !path.includes('agentDrafter') && !path.includes('agentRouter') &&
		!path.includes('agent/walker') &&
		!path.includes('agent/steps/index') &&
		!path.includes('agent/steps/shared') &&
		!path.includes('agent/steps/classify') &&
		!path.includes('agent/steps/draft') && !path.includes('knowledgeExtraction') && !path.includes('semanticFileProcessing') && !path.includes('visualizationAgent') && !path.includes('llmProvider')
	)
);

// ============ get ============

describe('codeWorkTasks.get', () => {
	it('should return a task by ID', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox.codeTasks']);
		let taskId!: Id<'codeWorkTasks'>;

		await t.run(async (ctx) => {
			taskId = await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({
				description: 'Implement login page',
			}));
		});

		const task = await t.query(api.codeWorkTasks.get, { taskId });
		expect(task).not.toBeNull();
		expect(task!.description).toBe('Implement login page');
		expect(task!.status).toBe('queued');
	});
});

// ============ listByStatus ============

describe('codeWorkTasks.listByStatus', () => {
	it('should return tasks filtered by status', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({ status: 'queued' }));
			await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({ status: 'queued' }));
			await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({ status: 'running' }));
			await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({ status: 'failed' }));
		});

		const queued = await t.query(api.codeWorkTasks.listByStatus, { status: 'queued' });
		expect(queued).toHaveLength(2);

		const running = await t.query(api.codeWorkTasks.listByStatus, { status: 'running' });
		expect(running).toHaveLength(1);
	});

	it('should return empty array when no tasks match status', async () => {
		const t = convexTest(schema, modules);
		const tasks = await t.query(api.codeWorkTasks.listByStatus, { status: 'merged' });
		expect(tasks).toEqual([]);
	});
});

// ============ listRecent ============

describe('codeWorkTasks.listRecent', () => {
	it('should return tasks in descending order by creation', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({
				description: 'Older task',
				createdAt: Date.now() - 2000,
			}));
			await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({
				description: 'Newer task',
				createdAt: Date.now(),
			}));
		});

		const tasks = await t.query(api.codeWorkTasks.listRecent, {});
		expect(tasks).toHaveLength(2);
		expect(tasks[0]!.description).toBe('Newer task');
		expect(tasks[1]!.description).toBe('Older task');
	});
});

// ============ getNextQueued ============

describe('codeWorkTasks.getNextQueued', () => {
	it('should return the first queued task', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({
				status: 'running',
				description: 'Already running',
			}));
			await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({
				status: 'queued',
				description: 'Next in line',
			}));
		});

		const next = await t.query(internal.codeWorkTasks.getNextQueued);
		expect(next).not.toBeNull();
		expect(next!.description).toBe('Next in line');
	});

	it('should return null when no queued tasks exist', async () => {
		const t = convexTest(schema, modules);
		const next = await t.query(internal.codeWorkTasks.getNextQueued);
		expect(next).toBeNull();
	});
});

// ============ create (user mutation) ============

describe('codeWorkTasks.create', () => {
	it('should create a new task with queued status', async () => {
		const t = convexTest(schema, modules);

		const taskId = await t.mutation(api.codeWorkTasks.create, {
			description: 'Build REST API endpoint for contacts',
		});

		expect(taskId).toBeDefined();

		await t.run(async (ctx) => {
			const task = await ctx.db.get(taskId);
			expect(task!.description).toBe('Build REST API endpoint for contacts');
			expect(task!.status).toBe('queued');
			expect(task!.createdAt).toBeTypeOf('number');
			expect(task!.updatedAt).toBeTypeOf('number');
		});
	});
});

// ============ cancel (user mutation) ============

describe('codeWorkTasks.cancel', () => {
	it('should cancel a queued task', async () => {
		const t = convexTest(schema, modules);
		let taskId!: Id<'codeWorkTasks'>;

		await t.run(async (ctx) => {
			taskId = await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({ status: 'queued' }));
		});

		await t.mutation(api.codeWorkTasks.cancel, { taskId });

		await t.run(async (ctx) => {
			const task = await ctx.db.get(taskId);
			expect(task!.status).toBe('failed');
			expect(task!.errorMessage).toBe('Cancelled by user');
		});
	});

	it('should throw when cancelling a merged task', async () => {
		const t = convexTest(schema, modules);
		let taskId!: Id<'codeWorkTasks'>;

		await t.run(async (ctx) => {
			taskId = await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({ status: 'merged' }));
		});

		await expect(
			t.mutation(api.codeWorkTasks.cancel, { taskId })
		).rejects.toThrow('Cannot cancel a merged task');
	});
});

// ============ claim (internal) ============

describe('codeWorkTasks.claim', () => {
	it('should claim a queued task and transition to running', async () => {
		const t = convexTest(schema, modules);
		let taskId!: Id<'codeWorkTasks'>;

		await t.run(async (ctx) => {
			taskId = await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({ status: 'queued' }));
		});

		const result = await t.mutation(internal.codeWorkTasks.claim, { taskId });
		expect(result.claimed).toBe(true);

		await t.run(async (ctx) => {
			const task = await ctx.db.get(taskId);
			expect(task!.status).toBe('running');
		});
	});

	it('should not claim a non-queued task', async () => {
		const t = convexTest(schema, modules);
		let taskId!: Id<'codeWorkTasks'>;

		await t.run(async (ctx) => {
			taskId = await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({ status: 'running' }));
		});

		const result = await t.mutation(internal.codeWorkTasks.claim, { taskId });
		expect(result.claimed).toBe(false);
	});
});

// ============ updateBranch (internal) ============

describe('codeWorkTasks.updateBranch', () => {
	it('should set branch on task', async () => {
		const t = convexTest(schema, modules);
		let taskId!: Id<'codeWorkTasks'>;

		await t.run(async (ctx) => {
			taskId = await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({ status: 'running' }));
		});

		await t.mutation(internal.codeWorkTasks.updateBranch, {
			taskId,
			branch: 'feature/contact-api',
		});

		await t.run(async (ctx) => {
			const task = await ctx.db.get(taskId);
			expect(task!.branch).toBe('feature/contact-api');
		});
	});
});

// ============ markTesting (internal) ============

describe('codeWorkTasks.markTesting', () => {
	it('should transition task to testing status', async () => {
		const t = convexTest(schema, modules);
		let taskId!: Id<'codeWorkTasks'>;

		await t.run(async (ctx) => {
			taskId = await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({ status: 'running' }));
		});

		await t.mutation(internal.codeWorkTasks.markTesting, { taskId });

		await t.run(async (ctx) => {
			const task = await ctx.db.get(taskId);
			expect(task!.status).toBe('testing');
		});
	});
});

// ============ completeWithPR (internal) ============

describe('codeWorkTasks.completeWithPR', () => {
	it('should move task to review with PR details', async () => {
		const t = convexTest(schema, modules);
		let taskId!: Id<'codeWorkTasks'>;

		await t.run(async (ctx) => {
			taskId = await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({ status: 'testing' }));
		});

		await t.mutation(internal.codeWorkTasks.completeWithPR, {
			taskId,
			prUrl: 'https://github.com/org/repo/pull/42',
			testResults: 'All 15 tests passed',
			llmCost: 0.85,
		});

		await t.run(async (ctx) => {
			const task = await ctx.db.get(taskId);
			expect(task!.status).toBe('review');
			expect(task!.prUrl).toBe('https://github.com/org/repo/pull/42');
			expect(task!.testResults).toBe('All 15 tests passed');
			expect(task!.llmCost).toBe(0.85);
		});
	});
});

// ============ markFailed (internal) ============

describe('codeWorkTasks.markFailed', () => {
	it('should mark task as failed with error message', async () => {
		const t = convexTest(schema, modules);
		let taskId!: Id<'codeWorkTasks'>;

		await t.run(async (ctx) => {
			taskId = await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({ status: 'running' }));
		});

		await t.mutation(internal.codeWorkTasks.markFailed, {
			taskId,
			errorMessage: 'Build failed: TypeScript compilation error',
			llmCost: 0.45,
		});

		await t.run(async (ctx) => {
			const task = await ctx.db.get(taskId);
			expect(task!.status).toBe('failed');
			expect(task!.errorMessage).toBe('Build failed: TypeScript compilation error');
			expect(task!.llmCost).toBe(0.45);
		});
	});
});

// ============ markMerged (internal) ============

describe('codeWorkTasks.markMerged', () => {
	it('should transition task to merged status', async () => {
		const t = convexTest(schema, modules);
		let taskId!: Id<'codeWorkTasks'>;

		await t.run(async (ctx) => {
			taskId = await ctx.db.insert('codeWorkTasks', createTestCodeWorkTask({ status: 'review' }));
		});

		await t.mutation(internal.codeWorkTasks.markMerged, { taskId });

		await t.run(async (ctx) => {
			const task = await ctx.db.get(taskId);
			expect(task!.status).toBe('merged');
		});
	});
});
