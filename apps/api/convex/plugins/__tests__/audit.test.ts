import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { parsePluginId } from '@owlat/plugin-kit';
import schema from '../../schema';
import { recordHostedPluginAudit } from '../audit';

const modules = import.meta.glob('../../**/*.*s');

describe('hosted plugin audit boundary', () => {
	it('writes trusted tenant/plugin attribution and bounded scalar metadata', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await recordHostedPluginAudit(
				ctx,
				{ organizationId: 'tenant', pluginId: parsePluginId('alpha'), userId: 'actor' },
				'llm.generate',
				'completed',
				{ attempts: 2, usageAvailable: true, chargedMicrousd: 12, actualMicrousd: 4 }
			);
			const row = await ctx.db.query('auditLogs').unique();
			expect(row).toMatchObject({
				organizationId: 'tenant',
				pluginId: 'alpha',
				userId: 'actor',
				action: 'plugin.action_completed',
				resource: 'plugin',
				details: { operation: 'llm.generate', outcome: 'completed', attempts: 2 },
			});
		});
	});

	it('rejects override fields, accessors, proxies, symbols, and arbitrary sensitive data', async () => {
		const t = convexTest(schema, modules);
		let getterReads = 0;
		const accessor = Object.defineProperty({}, 'reasonCode', {
			enumerable: true,
			get() {
				getterReads += 1;
				return 'provider_dispatch_failed';
			},
		});
		await t.run(async (ctx) => {
			for (const metadata of [
				{ operation: 'secret' },
				{ outcome: 'secret' },
				{ prompt: 'top secret' },
				{ reasonCode: 'raw provider error: secret' },
				{ [Symbol('secret')]: true },
				accessor,
				new Proxy({}, { ownKeys: () => { throw new Error('secret'); } }),
			]) {
				await expect(
					recordHostedPluginAudit(
						ctx,
						{ organizationId: 'tenant', pluginId: parsePluginId('alpha'), userId: 'actor' },
						'llm.generate',
						'failed',
						metadata as never
					)
				).rejects.toThrow('Invalid hosted plugin audit metadata');
			}
			expect(await ctx.db.query('auditLogs').take(1)).toEqual([]);
		});
		expect(getterReads).toBe(0);
	});
});
