/**
 * Shared harness for the outbound webhook delivery suites. The delivery action
 * runs by calling its handler directly, with `runMutation` routed into
 * convex-test, so the claim and outcome mutations are the real ones. A suite
 * using it mocks `../../lib/ssrfGuard` (the network edge) itself, since
 * `vi.mock` only applies to the file that declares it.
 */

import { convexTest } from 'convex-test';
import { vi } from 'vitest';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import schema from '../../schema';
import { createTestWebhook } from '../../__tests__/factories';
import { fetchWithGuardedDispatcher } from '../../lib/ssrfGuard';
import { deliverWebhookInternal } from '../delivery';

// Two globs merged, because Vite's `import.meta.glob` omits the directory chain
// it climbed to reach the base — see the note in `adapterRegistry.test.ts`.
export const modules = {
	...import.meta.glob('../../**/*.*s'),
	...Object.fromEntries(
		Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
			path.replace(/^\.\.\//, '../../webhooks/'),
			mod,
		])
	),
};

export type T = ReturnType<typeof convexTest>;
export type LogId = Id<'webhookDeliveryLogs'>;
export interface AttemptArgs {
	webhookId: Id<'webhooks'>;
	logId: LogId;
	attemptNumber: number;
	attemptSeq?: number;
	payload?: string;
}
export interface AttemptResult {
	success: boolean;
	skipped?: boolean;
	retrying?: boolean;
	error?: string;
}

const handler = (
	deliverWebhookInternal as unknown as {
		_handler: (ctx: unknown, args: AttemptArgs) => Promise<AttemptResult>;
	}
)._handler;

export const fetchMock = vi.mocked(fetchWithGuardedDispatcher);
export const sentHeaders = () =>
	fetchMock.mock.calls.map(([, init]) => (init?.headers ?? {}) as Record<string, string>);

export const PAYLOAD = {
	event: 'contact.created' as const,
	timestamp: '2026-09-23T12:00:00.000Z',
	data: { contactId: 'c1', email: 'someone@example.com' },
};

export function invoke(t: T, args: AttemptArgs): Promise<AttemptResult> {
	const runMutation = t.mutation as (ref: unknown, mutationArgs: unknown) => Promise<unknown>;
	return handler({ runMutation }, args);
}

export async function setup(webhook: Record<string, unknown> = {}) {
	const t = convexTest(schema, modules);
	const webhookId = await t.run((ctx) =>
		ctx.db.insert(
			'webhooks',
			createTestWebhook({
				url: 'https://hooks.example.com/owlat',
				isActive: true,
				events: ['contact.created'],
				...webhook,
			})
		)
	);
	return { t, webhookId };
}

export async function enqueue(t: T, webhookId: Id<'webhooks'>): Promise<LogId> {
	const logId = await t.mutation(internal.webhooks.deliveryQueries.enqueueDelivery, {
		webhookId,
		event: 'contact.created',
		payload: PAYLOAD,
	});
	return logId!;
}

export const row = (t: T, logId: LogId) => t.run(async (ctx) => (await ctx.db.get(logId))!);
export const job = (t: T, id: Id<'_scheduled_functions'> | undefined) =>
	t.run(async (ctx) => (id ? await ctx.db.system.get(id) : null));
export const reconcile = (t: T) =>
	t.mutation(internal.webhooks.deliveryReconciler.reconcileOverdueDeliveries, {});

/** The attempt the row currently expects, as its scheduler job would carry it. */
export async function currentAttempt(t: T, logId: LogId): Promise<AttemptArgs> {
	const log = await row(t, logId);
	return {
		webhookId: log.webhookId,
		logId,
		attemptNumber: log.attemptNumber,
		attemptSeq: log.attemptSeq,
	};
}

export function deferredResponse() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((r) => (resolve = r));
	return { promise, resolve };
}
