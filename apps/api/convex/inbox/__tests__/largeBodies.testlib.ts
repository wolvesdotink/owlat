/**
 * Shared fixtures for the Team Inbox large-body suites
 * (`largeBodiesReaders.test.ts`, `largeBodiesLifecycle.test.ts`).
 *
 * The bodies are sized the way real mail is: a 1.5 MiB HTML newsletter with a
 * short text part — within the inbound listener's 10 MiB raw limit and well
 * over the 1 MiB document limit that used to fail its insert — and each ends
 * in a canary so a test can tell the whole body from its opening.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Doc } from '../../_generated/dataModel';

export const SECRET = 'large-bodies-test-instance-secret-value';
export const TAIL_CANARY = 'TAIL-CANARY-7c1e-end-of-the-body';

/** An HTML body of `bytes` bytes that opens with `lead` and ends in the canary. */
export function htmlOfSize(bytes: number, lead = 'Monthly newsletter'): string {
	const head = `<html><body><p>${lead}</p>`;
	const tail = `<p>${TAIL_CANARY}</p></body></html>`;
	const row = '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>\n';
	const rows = Math.max(0, Math.floor((bytes - head.length - tail.length) / row.length));
	return head + row.repeat(rows) + tail;
}

export const MIB = 1024 * 1024;

// See receiveMessageAuth.test.ts: the `../../**` glob omits the `inbox/` dir it
// climbed through, so merge a second glob rooted at `inbox/` and re-prefix its keys.
const rootGlob = import.meta.glob('../../**/*.*s');
const inboxGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../inbox/'),
		mod,
	])
);
const modules = { ...rootGlob, ...inboxGlob };

export function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

export type TestConvex = ReturnType<typeof setupTest>;

/** Deliver one message through the raw-carrying route's action. */
export async function ingest(
	t: TestConvex,
	mail: { messageId: string; textBody?: string; htmlBody?: string; from?: string }
): Promise<{ isDuplicate: boolean }> {
	return await t.action(internal.inbox.inboundIngest.ingestFromWebhook, {
		mail: {
			from: mail.from ?? 'Dana <dana@example.com>',
			to: 'inbox@example.com',
			subject: 'A long one',
			textBody: mail.textBody,
			htmlBody: mail.htmlBody,
			headers: {},
			messageId: `<${mail.messageId}>`,
			attachments: [],
			timestamp: Date.now(),
		},
	});
}

export async function onlyRow(t: TestConvex): Promise<Doc<'inboundMessages'>> {
	const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
	if (rows.length !== 1) throw new Error(`expected one row, found ${rows.length}`);
	return rows[0]!;
}

export async function storedBlobCount(t: TestConvex): Promise<number> {
	return (await t.run((ctx) => ctx.db.system.query('_storage').collect())).length;
}
