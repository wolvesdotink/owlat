/**
 * The data variables an API caller supplied to a template send: only a role
 * that may edit transactional templates reads their values, and the retention
 * sweep removes them a day after the send finished, keeping their names.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type * as SessionOrganization from '../../lib/sessionOrganization';
import { newHarness } from '../../__tests__/testModules';
import { createTestTransactionalEmail } from '../../__tests__/factories';
import { SEND_DATA_VARIABLES_RETENTION_MS } from '../sendDataRetention';

const viewer = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'admin' | 'editor' }));
vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof SessionOrganization>();
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({ userId: 'viewer', role: viewer.role })),
	};
});

const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
const VARIABLES = { resetUrl: 'https://example.com/reset?token=secret-token', firstName: 'Ada' };

afterEach(() => {
	vi.useRealTimers();
	viewer.role = 'owner';
});

async function seedSend(
	t: ReturnType<typeof newHarness>,
	fields: { status: 'queued' | 'delivered'; sentAt?: number }
): Promise<{ templateId: Id<'transactionalEmails'>; sendId: Id<'transactionalSends'> }> {
	return await t.run(async (ctx) => {
		const templateId = await ctx.db.insert(
			'transactionalEmails',
			createTestTransactionalEmail({ status: 'published' })
		);
		const sendId = await ctx.db.insert('transactionalSends', {
			kind: 'transactional',
			transactionalEmailId: templateId,
			email: 'ada@example.com',
			dataVariables: VARIABLES,
			queuedAt: T0,
			...fields,
		});
		return { templateId, sendId };
	});
}

describe('who reads a send’s data variables', () => {
	it('shows an editor the names but not the values', async () => {
		vi.useFakeTimers({ now: T0 });
		const t = newHarness();
		const { templateId, sendId } = await seedSend(t, { status: 'delivered', sentAt: T0 });
		viewer.role = 'editor';

		const send = await t.query(api.transactional.sends.get, { id: sendId });
		const list = await t.query(api.transactional.sends.listByTransactionalEmail, {
			transactionalEmailId: templateId,
		});

		expect(send?.dataVariables).toBeUndefined();
		expect(send?.dataVariableNames).toEqual(['firstName', 'resetUrl']);
		expect(send?.dataVariablesAccess).toBe('hidden');
		expect(JSON.stringify(send)).not.toContain('secret-token');
		expect(JSON.stringify(list)).not.toContain('secret-token');
	});

	it('shows a role that manages templates the values', async () => {
		vi.useFakeTimers({ now: T0 });
		const t = newHarness();
		const { sendId } = await seedSend(t, { status: 'delivered', sentAt: T0 });
		viewer.role = 'admin';

		const send = await t.query(api.transactional.sends.get, { id: sendId });

		expect(send?.dataVariables).toEqual(VARIABLES);
		expect(send?.dataVariablesAccess).toBe('visible');
	});
});

describe('the data variable retention sweep', () => {
	it('removes the values a day after the send finished and keeps the names', async () => {
		vi.useFakeTimers({ now: T0 });
		const t = newHarness();
		const { sendId } = await seedSend(t, { status: 'delivered', sentAt: T0 });

		vi.setSystemTime(T0 + SEND_DATA_VARIABLES_RETENTION_MS - 60_000);
		await t.mutation(internal.transactional.sendDataRetention.sweepDataVariables, {});
		expect((await t.run((ctx) => ctx.db.get(sendId)))?.dataVariables).toEqual(VARIABLES);

		vi.setSystemTime(T0 + SEND_DATA_VARIABLES_RETENTION_MS + 60_000);
		await t.mutation(internal.transactional.sendDataRetention.sweepDataVariables, {});

		const row = await t.run((ctx) => ctx.db.get(sendId));
		expect(row?.dataVariables).toBeUndefined();
		expect(row?.dataVariableNames).toEqual(['firstName', 'resetUrl']);
		const send = await t.query(api.transactional.sends.get, { id: sendId });
		expect(send?.dataVariablesAccess).toBe('redacted');
		expect(send?.dataVariableNames).toEqual(['firstName', 'resetUrl']);
	});

	it('keeps the values of a send that is still queued', async () => {
		vi.useFakeTimers({ now: T0 });
		const t = newHarness();
		const { sendId } = await seedSend(t, { status: 'queued' });

		vi.setSystemTime(T0 + 3 * SEND_DATA_VARIABLES_RETENTION_MS);
		await t.mutation(internal.transactional.sendDataRetention.sweepDataVariables, {});

		expect((await t.run((ctx) => ctx.db.get(sendId)))?.dataVariables).toEqual(VARIABLES);
	});
});
