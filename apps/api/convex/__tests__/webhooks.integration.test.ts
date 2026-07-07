import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestWebhook, enableFeatures } from './factories';
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
		requireAuthenticatedIdentity: vi
			.fn()
			.mockResolvedValue({
				subject: 'test-user',
				issuer: 'test',
				tokenIdentifier: 'test|test-user',
			}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) => !path.includes('sesActions'))
);

// ============ webhooks.create ============

describe('webhooks.create', () => {
	it('should create a webhook with a generated secret', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(api.webhooks.endpoints.create, {
			name: 'My Webhook',
			url: 'https://example.com/webhook',
			events: ['email.sent'],
		});

		expect(result.webhookId).toBeDefined();
		expect(result.name).toBe('My Webhook');
		expect(result.url).toBe('https://example.com/webhook');
		expect(result.events).toEqual(['email.sent']);
		expect(result.isActive).toBe(true);
		expect(result.secret).toMatch(/^whsec_/);
		expect(result.secret).toHaveLength(38); // 'whsec_' (6) + 32 chars
	});

	it('should create a webhook with multiple events', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(api.webhooks.endpoints.create, {
			name: 'Multi Event Webhook',
			url: 'https://example.com/hook',
			events: ['email.sent', 'email.delivered', 'contact.created'],
		});

		expect(result.events).toEqual(['email.sent', 'email.delivered', 'contact.created']);
	});

	it('should trim name and url', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(api.webhooks.endpoints.create, {
			name: '  My Webhook  ',
			url: '  https://example.com/webhook  ',
			events: ['email.sent'],
		});

		expect(result.name).toBe('My Webhook');
		expect(result.url).toBe('https://example.com/webhook');
	});

	it('should persist webhook to database', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(api.webhooks.endpoints.create, {
			name: 'Persisted Webhook',
			url: 'https://example.com/hook',
			events: ['email.sent'],
		});

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(result.webhookId);
			expect(webhook).toBeDefined();
			expect(webhook!.name).toBe('Persisted Webhook');
			expect(webhook!.isActive).toBe(true);
			expect(webhook!.secret).toMatch(/^whsec_/);
			expect(webhook!.createdAt).toBeTypeOf('number');
			expect(webhook!.updatedAt).toBeTypeOf('number');
		});
	});

	// Validation: empty name
	it('should reject empty name', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: '',
				url: 'https://example.com/webhook',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	it('should reject whitespace-only name', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: '   ',
				url: 'https://example.com/webhook',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	// Validation: empty URL
	it('should reject empty URL', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test Webhook',
				url: '',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	it('should reject whitespace-only URL', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test Webhook',
				url: '   ',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	// Validation: invalid URL format
	it('should reject invalid URL format', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test Webhook',
				url: 'not-a-valid-url',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	// Validation: non-HTTP/HTTPS protocols
	it('should reject ftp:// URLs', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test Webhook',
				url: 'ftp://example.com/webhook',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	it('should reject file:// URLs', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test Webhook',
				url: 'file:///etc/passwd',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	// Validation: SSRF prevention — private/internal URLs
	it('should reject localhost', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test',
				url: 'https://localhost/webhook',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	it('should reject 127.0.0.1', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test',
				url: 'https://127.0.0.1/webhook',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	it('should reject 0.0.0.0', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test',
				url: 'https://0.0.0.0/webhook',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	it('should reject 10.x.x.x private range', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test',
				url: 'https://10.0.0.1/webhook',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	it('should reject 10.255.255.255 (upper bound)', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test',
				url: 'https://10.255.255.255/webhook',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	it('should reject 192.168.x.x private range', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test',
				url: 'https://192.168.1.1/webhook',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	it('should reject 192.168.0.0', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test',
				url: 'https://192.168.0.0/webhook',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	it('should reject 172.16.x.x private range', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test',
				url: 'https://172.16.0.1/webhook',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	it('should reject 172.31.255.255 (upper bound of private range)', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test',
				url: 'https://172.31.255.255/webhook',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	it('should allow 172.15.255.255 (outside private range)', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(api.webhooks.endpoints.create, {
			name: 'Test',
			url: 'https://172.15.255.255/webhook',
			events: ['email.sent'],
		});

		expect(result.webhookId).toBeDefined();
	});

	it('should allow 172.32.0.0 (outside private range)', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(api.webhooks.endpoints.create, {
			name: 'Test',
			url: 'https://172.32.0.0/webhook',
			events: ['email.sent'],
		});

		expect(result.webhookId).toBeDefined();
	});

	it('should reject 169.254.x.x link-local range', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test',
				url: 'https://169.254.169.254/latest/meta-data/',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	it('should reject .local domains', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test',
				url: 'https://myservice.local/webhook',
				events: ['email.sent'],
			})
		).rejects.toThrow();
	});

	it('should allow valid public URLs', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(api.webhooks.endpoints.create, {
			name: 'Public Webhook',
			url: 'https://hooks.slack.com/services/T00/B00/xxx',
			events: ['email.sent'],
		});

		expect(result.webhookId).toBeDefined();
	});

	it('should allow http:// URLs', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(api.webhooks.endpoints.create, {
			name: 'HTTP Webhook',
			url: 'http://example.com/webhook',
			events: ['email.sent'],
		});

		expect(result.webhookId).toBeDefined();
	});

	// Validation: empty events
	it('should reject empty events array', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.webhooks.endpoints.create, {
				name: 'Test Webhook',
				url: 'https://example.com/webhook',
				events: [],
			})
		).rejects.toThrow();
	});
});

// ============ webhooks.update ============

describe('webhooks.update', () => {
	it('should update name only', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert(
				'webhooks',
				createTestWebhook({
					name: 'Original Name',
					url: 'https://example.com/hook',
				})
			);
		});

		await t.mutation(api.webhooks.endpoints.update, {
			webhookId,
			name: 'Updated Name',
		});

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook!.name).toBe('Updated Name');
			expect(webhook!.url).toBe('https://example.com/hook');
		});
	});

	it('should update url only', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert(
				'webhooks',
				createTestWebhook({
					name: 'My Webhook',
					url: 'https://old.example.com/hook',
				})
			);
		});

		await t.mutation(api.webhooks.endpoints.update, {
			webhookId,
			url: 'https://new.example.com/hook',
		});

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook!.url).toBe('https://new.example.com/hook');
			expect(webhook!.name).toBe('My Webhook');
		});
	});

	it('should update events only', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert(
				'webhooks',
				createTestWebhook({
					events: ['email.sent'],
				})
			);
		});

		await t.mutation(api.webhooks.endpoints.update, {
			webhookId,
			events: ['email.sent', 'email.delivered', 'contact.created'],
		});

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook!.events).toEqual(['email.sent', 'email.delivered', 'contact.created']);
		});
	});

	it('should update multiple fields at once', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook());
		});

		await t.mutation(api.webhooks.endpoints.update, {
			webhookId,
			name: 'New Name',
			url: 'https://new.example.com/hook',
			events: ['email.bounced'],
		});

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook!.name).toBe('New Name');
			expect(webhook!.url).toBe('https://new.example.com/hook');
			expect(webhook!.events).toEqual(['email.bounced']);
		});
	});

	it('should update the updatedAt timestamp', async () => {
		const t = convexTest(schema, modules);

		const originalUpdatedAt = Date.now() - 10000;
		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert(
				'webhooks',
				createTestWebhook({
					updatedAt: originalUpdatedAt,
				})
			);
		});

		await t.mutation(api.webhooks.endpoints.update, {
			webhookId,
			name: 'Updated',
		});

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook!.updatedAt).toBeGreaterThan(originalUpdatedAt);
		});
	});

	it('should reject empty name', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook());
		});

		await expect(
			t.mutation(api.webhooks.endpoints.update, { webhookId, name: '' })
		).rejects.toThrow();
	});

	it('should reject empty URL', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook());
		});

		await expect(
			t.mutation(api.webhooks.endpoints.update, { webhookId, url: '' })
		).rejects.toThrow();
	});

	it('should reject invalid URL format', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook());
		});

		await expect(
			t.mutation(api.webhooks.endpoints.update, { webhookId, url: 'not-a-url' })
		).rejects.toThrow();
	});

	it('should reject private URLs (SSRF)', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook());
		});

		await expect(
			t.mutation(api.webhooks.endpoints.update, { webhookId, url: 'https://10.0.0.1/hook' })
		).rejects.toThrow();
	});

	it('should reject non-HTTP/HTTPS URLs', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook());
		});

		await expect(
			t.mutation(api.webhooks.endpoints.update, { webhookId, url: 'ftp://example.com/hook' })
		).rejects.toThrow();
	});

	it('should reject empty events array', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook());
		});

		await expect(
			t.mutation(api.webhooks.endpoints.update, { webhookId, events: [] })
		).rejects.toThrow();
	});

	it('should throw for non-existent webhook', async () => {
		const t = convexTest(schema, modules);

		// Insert and delete to get a valid-format but non-existent ID
		const webhookId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('webhooks', createTestWebhook());
			await ctx.db.delete(id);
			return id;
		});

		await expect(
			t.mutation(api.webhooks.endpoints.update, { webhookId, name: 'Test' })
		).rejects.toThrow();
	});
});

// ============ webhooks.toggle ============

describe('webhooks.toggle', () => {
	it('should toggle active to inactive', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook({ isActive: true }));
		});

		const result = await t.mutation(api.webhooks.endpoints.toggle, { webhookId });

		expect(result.isActive).toBe(false);

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook!.isActive).toBe(false);
		});
	});

	it('should toggle inactive to active', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook({ isActive: false }));
		});

		const result = await t.mutation(api.webhooks.endpoints.toggle, { webhookId });

		expect(result.isActive).toBe(true);

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook!.isActive).toBe(true);
		});
	});

	it('should update updatedAt on toggle', async () => {
		const t = convexTest(schema, modules);

		const oldTime = Date.now() - 10000;
		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook({ updatedAt: oldTime }));
		});

		await t.mutation(api.webhooks.endpoints.toggle, { webhookId });

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook!.updatedAt).toBeGreaterThan(oldTime);
		});
	});
});

// ============ webhooks.enable / webhooks.disable ============

describe('webhooks.enable', () => {
	it('should enable an inactive webhook', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook({ isActive: false }));
		});

		const result = await t.mutation(api.webhooks.endpoints.enable, { webhookId });
		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook!.isActive).toBe(true);
		});
	});

	it('should be a no-op for already-active webhook', async () => {
		const t = convexTest(schema, modules);

		const originalTime = Date.now() - 10000;
		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert(
				'webhooks',
				createTestWebhook({
					isActive: true,
					updatedAt: originalTime,
				})
			);
		});

		const result = await t.mutation(api.webhooks.endpoints.enable, { webhookId });
		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook!.isActive).toBe(true);
			// updatedAt should NOT change for no-op
			expect(webhook!.updatedAt).toBe(originalTime);
		});
	});
});

describe('webhooks.disable', () => {
	it('should disable an active webhook', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook({ isActive: true }));
		});

		const result = await t.mutation(api.webhooks.endpoints.disable, { webhookId });
		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook!.isActive).toBe(false);
		});
	});

	it('should be a no-op for already-inactive webhook', async () => {
		const t = convexTest(schema, modules);

		const originalTime = Date.now() - 10000;
		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert(
				'webhooks',
				createTestWebhook({
					isActive: false,
					updatedAt: originalTime,
				})
			);
		});

		const result = await t.mutation(api.webhooks.endpoints.disable, { webhookId });
		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook!.isActive).toBe(false);
			// updatedAt should NOT change for no-op
			expect(webhook!.updatedAt).toBe(originalTime);
		});
	});
});

// ============ webhooks.regenerateSecret ============

describe('webhooks.regenerateSecret', () => {
	it('should return a new secret starting with whsec_', async () => {
		const t = convexTest(schema, modules);

		const originalSecret = 'whsec_OriginalSecretValue12345678';
		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook({ secret: originalSecret }));
		});

		const result = await t.mutation(api.webhooks.endpoints.regenerateSecret, { webhookId });

		expect(result.secret).toMatch(/^whsec_/);
		expect(result.secret).toHaveLength(38);
		expect(result.secret).not.toBe(originalSecret);
	});

	it('should persist the new secret in the database', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook({ secret: 'whsec_old' }));
		});

		const result = await t.mutation(api.webhooks.endpoints.regenerateSecret, { webhookId });

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook!.secret).toBe(result.secret);
		});
	});

	it('should update updatedAt', async () => {
		const t = convexTest(schema, modules);

		const oldTime = Date.now() - 10000;
		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook({ updatedAt: oldTime }));
		});

		await t.mutation(api.webhooks.endpoints.regenerateSecret, { webhookId });

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook!.updatedAt).toBeGreaterThan(oldTime);
		});
	});

	it('should throw for non-existent webhook', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('webhooks', createTestWebhook());
			await ctx.db.delete(id);
			return id;
		});

		await expect(
			t.mutation(api.webhooks.endpoints.regenerateSecret, { webhookId })
		).rejects.toThrow();
	});
});

// ============ webhooks.remove ============

describe('webhooks.remove', () => {
	it('should delete the webhook', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook());
		});

		const result = await t.mutation(api.webhooks.endpoints.remove, { webhookId });
		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook).toBeNull();
		});
	});

	it('should delete associated delivery logs', async () => {
		const t = convexTest(schema, modules);

		const { webhookId, logIds } = await t.run(async (ctx) => {
			const wId = await ctx.db.insert('webhooks', createTestWebhook());
			const now = Date.now();

			const ids: Id<'webhookDeliveryLogs'>[] = [];
			for (let i = 0; i < 3; i++) {
				const logId = await ctx.db.insert('webhookDeliveryLogs', {
					webhookId: wId,
					event: 'test',
					payload: { event: 'test', timestamp: new Date(now).toISOString(), data: { test: true } },
					attemptNumber: 1,
					maxAttempts: 3,
					status: 'success',
					scheduledAt: now,
				});
				ids.push(logId);
			}

			return { webhookId: wId, logIds: ids };
		});

		// `remove` deletes the webhook synchronously and drains its delivery logs
		// via a `runAfter(0)` internal mutation — flush it before asserting.
		vi.useFakeTimers();
		try {
			await t.mutation(api.webhooks.endpoints.remove, { webhookId });
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		await t.run(async (ctx) => {
			const webhook = await ctx.db.get(webhookId);
			expect(webhook).toBeNull();

			for (const logId of logIds) {
				const log = await ctx.db.get(logId);
				expect(log).toBeNull();
			}
		});
	});

	it('should throw for non-existent webhook', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('webhooks', createTestWebhook());
			await ctx.db.delete(id);
			return id;
		});

		await expect(t.mutation(api.webhooks.endpoints.remove, { webhookId })).rejects.toThrow();
	});
});

// ============ webhooks.listByOrganization ============

describe('webhooks.listByOrganization', () => {
	it('should return only active webhooks by default', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['webhooks']);

		await t.run(async (ctx) => {
			await ctx.db.insert('webhooks', createTestWebhook({ name: 'Active 1', isActive: true }));
			await ctx.db.insert('webhooks', createTestWebhook({ name: 'Active 2', isActive: true }));
			await ctx.db.insert('webhooks', createTestWebhook({ name: 'Inactive', isActive: false }));
		});

		const result = await t.query(api.webhooks.endpoints.listByOrganization, {});

		expect(result).toHaveLength(2);
		expect(result.every((w) => w.isActive)).toBe(true);
	});

	it('should return all webhooks when includeInactive is true', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['webhooks']);

		await t.run(async (ctx) => {
			await ctx.db.insert('webhooks', createTestWebhook({ name: 'Active', isActive: true }));
			await ctx.db.insert('webhooks', createTestWebhook({ name: 'Inactive', isActive: false }));
		});

		const result = await t.query(api.webhooks.endpoints.listByOrganization, {
			includeInactive: true,
		});

		expect(result).toHaveLength(2);
	});

	it('should return empty array when no webhooks exist', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['webhooks']);

		const result = await t.query(api.webhooks.endpoints.listByOrganization, {});

		expect(result).toEqual([]);
	});

	it('should sort by createdAt descending (newest first)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['webhooks']);

		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('webhooks', createTestWebhook({ name: 'Old', createdAt: now - 2000 }));
			await ctx.db.insert('webhooks', createTestWebhook({ name: 'New', createdAt: now }));
			await ctx.db.insert('webhooks', createTestWebhook({ name: 'Mid', createdAt: now - 1000 }));
		});

		const result = await t.query(api.webhooks.endpoints.listByOrganization, {});

		expect(result[0]!.name).toBe('New');
		expect(result[1]!.name).toBe('Mid');
		expect(result[2]!.name).toBe('Old');
	});

	it('should NOT include the HMAC secret in any returned webhook', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['webhooks']);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'webhooks',
				createTestWebhook({
					name: 'Active',
					isActive: true,
					secret: 'whsec_ActiveSecretValue1234567890',
				})
			);
			await ctx.db.insert(
				'webhooks',
				createTestWebhook({
					name: 'Inactive',
					isActive: false,
					secret: 'whsec_InactiveSecretValue123456789',
				})
			);
		});

		const active = await t.query(api.webhooks.endpoints.listByOrganization, {});
		const all = await t.query(api.webhooks.endpoints.listByOrganization, {
			includeInactive: true,
		});

		expect(active.length).toBeGreaterThan(0);
		for (const w of [...active, ...all]) {
			expect(w).not.toHaveProperty('secret');
			// Non-secret fields are still present.
			expect(w.name).toBeDefined();
			expect(w.url).toBeDefined();
		}
	});
});

// ============ webhooks.get ============

describe('webhooks.get', () => {
	it('should return webhook by ID', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook({ name: 'My Hook' }));
		});

		const result = await t.query(api.webhooks.endpoints.get, { webhookId });

		expect(result).toBeDefined();
		expect(result!.name).toBe('My Hook');
		expect(result!._id).toBe(webhookId);
	});

	it('should return null for non-existent webhook', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('webhooks', createTestWebhook());
			await ctx.db.delete(id);
			return id;
		});

		const result = await t.query(api.webhooks.endpoints.get, { webhookId });
		expect(result).toBeNull();
	});

	it('should NOT include the HMAC secret', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert(
				'webhooks',
				createTestWebhook({
					name: 'My Hook',
					secret: 'whsec_GetSecretValue12345678901234',
				})
			);
		});

		const result = await t.query(api.webhooks.endpoints.get, { webhookId });

		expect(result).not.toBeNull();
		expect(result).not.toHaveProperty('secret');
		// Non-secret fields are still returned.
		expect(result!.name).toBe('My Hook');
		expect(result!._id).toBe(webhookId);
	});
});

// ============ webhooks.countByOrganization ============

describe('webhooks.countByOrganization', () => {
	it('should return total and active counts', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('webhooks', createTestWebhook({ isActive: true }));
			await ctx.db.insert('webhooks', createTestWebhook({ isActive: true }));
			await ctx.db.insert('webhooks', createTestWebhook({ isActive: false }));
		});

		const result = await t.query(api.webhooks.endpoints.countByOrganization, {});

		expect(result.total).toBe(3);
		expect(result.active).toBe(2);
	});

	it('should return zeros when no webhooks exist', async () => {
		const t = convexTest(schema, modules);

		const result = await t.query(api.webhooks.endpoints.countByOrganization, {});

		expect(result.total).toBe(0);
		expect(result.active).toBe(0);
	});

	it('should count all webhooks', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('webhooks', createTestWebhook({ isActive: true }));
			await ctx.db.insert('webhooks', createTestWebhook({ isActive: true }));
		});

		const result = await t.query(api.webhooks.endpoints.countByOrganization, {});

		expect(result.total).toBe(2);
		expect(result.active).toBe(2);
	});
});

// ============ webhooks.sendTestWebhook ============

describe('webhooks.sendTestWebhook', () => {
	it('should create a delivery log and return success', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook({ isActive: true }));
		});

		const result = await t.mutation(api.webhooks.endpoints.sendTestWebhook, { webhookId });

		expect(result.success).toBe(true);
		expect(result.logId).toBeDefined();

		await t.run(async (ctx) => {
			const log = await ctx.db.get(result.logId);
			expect(log).toBeDefined();
			expect(log!.webhookId).toBe(webhookId);
			expect(log!.event).toBe('test');
			expect(log!.status).toBe('pending');
			expect(log!.attemptNumber).toBe(1);
			expect(log!.maxAttempts).toBe(3);
			expect(log!.webhookId).toBe(webhookId);
		});

		// Let scheduled functions run
		await new Promise((resolve) => setTimeout(resolve, 0));
		await t.finishInProgressScheduledFunctions();
	});

	it('should reject if webhook is inactive', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook({ isActive: false }));
		});

		await expect(
			t.mutation(api.webhooks.endpoints.sendTestWebhook, { webhookId })
		).rejects.toThrow();
	});

	it('should throw for non-existent webhook', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('webhooks', createTestWebhook());
			await ctx.db.delete(id);
			return id;
		});

		await expect(
			t.mutation(api.webhooks.endpoints.sendTestWebhook, { webhookId })
		).rejects.toThrow();
	});
});

// ============ webhooks.getDeliveryStats ============

describe('webhooks.getDeliveryStats', () => {
	it('should compute success/failed/pending/retrying counts', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			const wId = await ctx.db.insert('webhooks', createTestWebhook());
			const now = Date.now();

			// 2 success, 1 failed, 1 pending, 1 retrying
			await ctx.db.insert('webhookDeliveryLogs', {
				webhookId: wId,
				event: 'email.sent',
				payload: { event: 'email.sent', timestamp: new Date(now).toISOString(), data: {} },
				attemptNumber: 1,
				maxAttempts: 3,
				status: 'success',
				scheduledAt: now,
			});
			await ctx.db.insert('webhookDeliveryLogs', {
				webhookId: wId,
				event: 'email.delivered',
				payload: { event: 'email.sent', timestamp: new Date(now).toISOString(), data: {} },
				attemptNumber: 1,
				maxAttempts: 3,
				status: 'success',
				scheduledAt: now,
			});
			await ctx.db.insert('webhookDeliveryLogs', {
				webhookId: wId,
				event: 'email.bounced',
				payload: { event: 'email.bounced', timestamp: new Date(now).toISOString(), data: {} },
				attemptNumber: 3,
				maxAttempts: 3,
				status: 'failed',
				scheduledAt: now,
			});
			await ctx.db.insert('webhookDeliveryLogs', {
				webhookId: wId,
				event: 'contact.created',
				payload: { event: 'contact.created', timestamp: new Date(now).toISOString(), data: {} },
				attemptNumber: 1,
				maxAttempts: 3,
				status: 'pending',
				scheduledAt: now,
			});
			await ctx.db.insert('webhookDeliveryLogs', {
				webhookId: wId,
				event: 'email.opened',
				payload: { event: 'email.opened', timestamp: new Date(now).toISOString(), data: {} },
				attemptNumber: 2,
				maxAttempts: 3,
				status: 'retrying',
				scheduledAt: now,
			});

			return wId;
		});

		const stats = await t.query(api.webhooks.endpoints.getDeliveryStats, { webhookId });

		expect(stats.total).toBe(5);
		expect(stats.success).toBe(2);
		expect(stats.failed).toBe(1);
		expect(stats.pending).toBe(1);
		expect(stats.retrying).toBe(1);
		// successRate = round(2/(2+1)*100) = 67
		expect(stats.successRate).toBe(67);
	});

	it('should return zeros and 100% rate for no logs', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			return await ctx.db.insert('webhooks', createTestWebhook());
		});

		const stats = await t.query(api.webhooks.endpoints.getDeliveryStats, { webhookId });

		expect(stats.total).toBe(0);
		expect(stats.success).toBe(0);
		expect(stats.failed).toBe(0);
		expect(stats.pending).toBe(0);
		expect(stats.retrying).toBe(0);
		expect(stats.successRate).toBe(100);
	});

	it('should return defaults for non-existent webhook', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('webhooks', createTestWebhook());
			await ctx.db.delete(id);
			return id;
		});

		const stats = await t.query(api.webhooks.endpoints.getDeliveryStats, { webhookId });

		expect(stats.total).toBe(0);
		expect(stats.successRate).toBe(100);
	});

	it('should filter by since timestamp', async () => {
		const t = convexTest(schema, modules);

		const now = Date.now();
		const webhookId = await t.run(async (ctx) => {
			const wId = await ctx.db.insert('webhooks', createTestWebhook());

			// Old log (before filter)
			await ctx.db.insert('webhookDeliveryLogs', {
				webhookId: wId,
				event: 'email.sent',
				payload: { event: 'email.sent', timestamp: new Date(now - 100000).toISOString(), data: {} },
				attemptNumber: 1,
				maxAttempts: 3,
				status: 'success',
				scheduledAt: now - 100000,
			});
			// Recent log (after filter)
			await ctx.db.insert('webhookDeliveryLogs', {
				webhookId: wId,
				event: 'email.sent',
				payload: { event: 'email.sent', timestamp: new Date(now).toISOString(), data: {} },
				attemptNumber: 1,
				maxAttempts: 3,
				status: 'failed',
				scheduledAt: now,
			});

			return wId;
		});

		const stats = await t.query(api.webhooks.endpoints.getDeliveryStats, {
			webhookId,
			since: now - 50000,
		});

		expect(stats.total).toBe(1);
		expect(stats.failed).toBe(1);
		expect(stats.success).toBe(0);
	});

	it('should compute 100% success rate when all completed are successful', async () => {
		const t = convexTest(schema, modules);

		const webhookId = await t.run(async (ctx) => {
			const wId = await ctx.db.insert('webhooks', createTestWebhook());
			const now = Date.now();

			await ctx.db.insert('webhookDeliveryLogs', {
				webhookId: wId,
				event: 'email.sent',
				payload: { event: 'email.sent', timestamp: new Date(now).toISOString(), data: {} },
				attemptNumber: 1,
				maxAttempts: 3,
				status: 'success',
				scheduledAt: now,
			});
			await ctx.db.insert('webhookDeliveryLogs', {
				webhookId: wId,
				event: 'email.sent',
				payload: { event: 'email.sent', timestamp: new Date(now).toISOString(), data: {} },
				attemptNumber: 1,
				maxAttempts: 3,
				status: 'success',
				scheduledAt: now,
			});
			// pending doesn't count toward rate
			await ctx.db.insert('webhookDeliveryLogs', {
				webhookId: wId,
				event: 'email.sent',
				payload: { event: 'contact.created', timestamp: new Date(now).toISOString(), data: {} },
				attemptNumber: 1,
				maxAttempts: 3,
				status: 'pending',
				scheduledAt: now,
			});

			return wId;
		});

		const stats = await t.query(api.webhooks.endpoints.getDeliveryStats, { webhookId });

		expect(stats.successRate).toBe(100);
		expect(stats.total).toBe(3);
	});
});
