/**
 * `postmaster@` and `abuse@` on the hosts the MTA sends as, driven through the
 * real port-25 listener (`createBounceServer`) on a loopback socket.
 *
 * A complaint report sent to either address is processed exactly like one sent
 * to a `fbl+…@` address; anything else is handed to Convex as inbound mail and
 * never answered with a DSN. Every wait is on an SMTP reply from the socket.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { AddressInfo } from 'node:net';
import type { SmtpListener } from '@owlat/smtp-listener';
import { Client } from '@owlat/smtp-listener/testClient';
import type * as ConvexNotifierModule from '../../webhooks/convexNotifier.js';

const mocks = vi.hoisted(() => ({
	queueConvexWebhook: vi.fn(async (..._args: unknown[]) => 'outbox-id'),
	notifyConvex: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('../../webhooks/convexNotifier.js', async (importOriginal) => ({
	...(await importOriginal<typeof ConvexNotifierModule>()),
	queueConvexWebhook: mocks.queueConvexWebhook,
	notifyConvex: mocks.notifyConvex,
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createBounceServer } from '../server.js';
import { recordFeedbackProvenance } from '../feedbackProvenance.js';
import { buildVerpAddress } from '../verp.js';
import { setMailboxCache } from '../../inbound/mailboxResolver.js';
import { fblComplaintsUnknownProvenanceTotal } from '../../monitoring/collector.js';
import type { MtaConfig } from '../../config.js';
import type { EmailJob } from '../../types.js';

const VERP_KEY = 'system-mailbox-verp-key-0123456789ab';
const RETURN_PATH_DOMAIN = 'bounces.owlat.test';
const MESSAGE_ID = 'send_systemMailbox0001';
const RECIPIENT = 'complainer@example.net';

function makeConfig(): MtaConfig {
	return {
		ehloHostname: 'mx.owlat.test',
		ehloHostnames: {},
		returnPathDomain: RETURN_PATH_DOMAIN,
		convexSiteUrl: 'https://acme.convex.site',
		webhookSecret: 'mta-test-secret',
		bounceMaxClients: 50,
		bounceMaxConnectionsPerIp: 50,
		bounceTarpitEnabled: false,
		bounceTarpitDelayMs: 0,
		bounceSocketTimeoutMs: 60000,
		inboundSpfEnabled: false,
		inboundDkimEnabled: false,
		inboundDmarcEnabled: false,
		inboundArcEnabled: false,
	} as unknown as MtaConfig;
}

const listeners: SmtpListener[] = [];
let redisPort = 26379;
let redis: InstanceType<typeof Redis>;

async function start(): Promise<number> {
	const listener = createBounceServer(makeConfig(), redis as never);
	await listener.listen(0, '127.0.0.1');
	listeners.push(listener);
	return (listener.address() as AddressInfo).port;
}

/** Wait for the next final reply after `seen` characters; resolve with it and the new length. */
async function nextReply(c: Client, seen: number): Promise<{ line: string; length: number }> {
	let reply = '';
	let length = seen;
	await c.waitFor((buffer) => {
		const match = /^(\d{3}) [^\r\n]*\r\n/m.exec(buffer.slice(seen));
		if (!match) return false;
		reply = match[0].trim();
		length = seen + match.index + match[0].length;
		return true;
	});
	return { line: reply, length };
}

/** One complete SMTP transaction; resolves with the RCPT refusal or the final DATA reply. */
async function deliver(
	port: number,
	rcptTo: string,
	message: string,
	mailFrom = ''
): Promise<string> {
	const c = await Client.connect(port);
	try {
		let reply = await nextReply(c, 0);
		const send = async (line: string) => {
			c.write(line);
			reply = await nextReply(c, reply.length);
			return reply.line;
		};
		await send('EHLO sender.example.net\r\n');
		await send(`MAIL FROM:<${mailFrom}>\r\n`);
		const rcpt = await send(`RCPT TO:<${rcptTo}>\r\n`);
		if (!rcpt.startsWith('250 ')) return rcpt;
		await send('DATA\r\n');
		return await send(`${message.replace(/\r?\n/g, '\r\n')}\r\n.\r\n`);
	} finally {
		c.end();
	}
}

function arfReport(feedbackFields: string[]): string {
	return [
		'From: feedbackloop@isp.example',
		`To: abuse@${RETURN_PATH_DOMAIN}`,
		'Subject: Spam Feedback Report',
		'MIME-Version: 1.0',
		'Content-Type: multipart/report; report-type=feedback-report; boundary="arf"',
		'',
		'--arf',
		'Content-Type: text/plain',
		'',
		'An abuse complaint.',
		'--arf',
		'Content-Type: message/feedback-report',
		'',
		'Feedback-Type: abuse',
		'User-Agent: Example Feedback Loop/1.0',
		...feedbackFields,
		'--arf--',
		'',
	].join('\n');
}

/** A complaint that is only a forward of the original, as an attachment. */
function forwardedOriginal(returnPath: string): string {
	return [
		'From: Junk Reports <junk@isp.example>',
		`To: abuse@${RETURN_PATH_DOMAIN}`,
		'Subject: FW: unwanted mail',
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="fw"',
		'',
		'--fw',
		'Content-Type: text/plain',
		'',
		'A user reported the attached message as junk.',
		'--fw',
		'Content-Type: message/rfc822',
		'Content-Disposition: attachment',
		'',
		`Return-Path: <${returnPath}>`,
		'From: News <news@sender.example>',
		`To: ${RECIPIENT}`,
		'Subject: This week',
		'',
		'Hello.',
		'--fw--',
		'',
	].join('\n');
}

function queuedEvents(): string[] {
	return mocks.queueConvexWebhook.mock.calls.map(
		(call) => ((call as unknown[])[0] as { event: string }).event
	);
}

type NotifiedEvent = { event: string; inboundPayload?: { to: string; systemMailbox?: string } };

function notifiedEvents(): NotifiedEvent[] {
	return mocks.notifyConvex.mock.calls.map((call) => (call as unknown[])[0] as NotifiedEvent);
}

/** A plain message to `to`, the kind a blocklist operator or abuse desk writes. */
function plainMessage(to: string): string {
	return [
		'From: Admin <admin@example.org>',
		`To: ${to}`,
		'Subject: Your server',
		'',
		'Please look at your PTR record.',
	].join('\n');
}

beforeEach(async () => {
	process.env['BOUNCE_VERP_KEY'] = VERP_KEY;
	redis = new Redis({ port: redisPort++ });
	await redis.set('mta:inbound-tls-required', '0');
	await recordFeedbackProvenance(redis, {
		messageId: MESSAGE_ID,
		to: RECIPIENT,
		organizationId: 'org-send',
		deliveryDomain: 'production',
		headers: {},
	} as EmailJob);
	vi.clearAllMocks();
});

afterEach(async () => {
	while (listeners.length > 0) await listeners.pop()?.close();
	delete process.env['BOUNCE_VERP_KEY'];
	await redis.quit();
});

describe('postmaster@ and abuse@ on the port-25 listener', () => {
	it('processes an ARF report sent to abuse@ as a complaint about the original send', async () => {
		const port = await start();
		const signed = buildVerpAddress(MESSAGE_ID, RETURN_PATH_DOMAIN, VERP_KEY);
		const reply = await deliver(
			port,
			`abuse@${RETURN_PATH_DOMAIN}`,
			arfReport([`Original-Mail-From: ${signed}`, 'Original-Rcpt-To: victim@example.org'])
		);
		expect(reply).toMatch(/^250 /);
		expect(mocks.queueConvexWebhook).toHaveBeenCalledTimes(1);
		expect(mocks.queueConvexWebhook.mock.calls[0]![0]).toMatchObject({
			event: 'complained',
			messageId: MESSAGE_ID,
			// From the send-time record, never from the report.
			recipient: RECIPIENT,
			organizationId: 'org-send',
		});
		expect(notifiedEvents().some((e) => e.event === 'inbound.received')).toBe(false);
	});

	it('hands any other message to Convex as inbound mail and sends no DSN', async () => {
		const port = await start();
		const reply = await deliver(
			port,
			`postmaster@mx.owlat.test`,
			[
				'From: Admin <admin@example.org>',
				'To: postmaster@mx.owlat.test',
				'Subject: Your server',
				'',
				'Please look at your PTR record.',
			].join('\n'),
			'admin@example.org'
		);
		expect(reply).toMatch(/^250 /);
		const events = notifiedEvents();
		expect(events.map((e) => e.event)).toEqual(['inbound.received']);
		expect(events[0]!.inboundPayload?.to).toBe('postmaster@mx.owlat.test');
		expect(mocks.queueConvexWebhook).not.toHaveBeenCalled();
	});

	it('marks the mail with the system mailbox it was addressed to', async () => {
		const port = await start();
		for (const to of ['postmaster@mx.owlat.test', `Abuse@${RETURN_PATH_DOMAIN}`]) {
			expect(await deliver(port, to, plainMessage(to), 'admin@example.org')).toMatch(/^250 /);
		}
		expect(notifiedEvents().map((e) => e.inboundPayload?.systemMailbox)).toEqual([
			'postmaster',
			'abuse',
		]);
	});

	it("leaves an operator's exact route of the same name unmarked", async () => {
		await redis.set(
			'mta:inbound-routes:mx.owlat.test:postmaster',
			JSON.stringify({
				id: 'route_operator',
				domain: 'mx.owlat.test',
				address: 'postmaster',
				mode: 'accept',
				createdAt: 1,
			})
		);
		const port = await start();
		const to = 'postmaster@mx.owlat.test';
		expect(await deliver(port, to, plainMessage(to), 'admin@example.org')).toMatch(/^250 /);
		const events = notifiedEvents();
		expect(events.map((e) => e.event)).toEqual(['inbound.received']);
		expect(events[0]!.inboundPayload).not.toHaveProperty('systemMailbox');
	});

	it('delivers to a real mailbox of the same name as that mailbox', async () => {
		await setMailboxCache(redis as never, 'postmaster@mx.owlat.test', {
			mailboxId: 'mbx_postmaster',
			organizationId: 'org_team',
			usedBytes: 0,
		});
		const port = await start();
		const to = 'postmaster@mx.owlat.test';
		expect(await deliver(port, to, plainMessage(to), 'admin@example.org')).toMatch(/^250 /);
		expect(notifiedEvents().map((e) => e.event)).toEqual(['inbound.mailbox.received']);
	});

	it('still refuses an unknown local part on the return-path host', async () => {
		const port = await start();
		const reply = await deliver(port, `nobody@${RETURN_PATH_DOMAIN}`, 'Subject: x\n\nx');
		expect(reply).toMatch(/^550 /);
	});

	it('reads a forwarded original whose Return-Path carries our signed VERP as a complaint', async () => {
		const port = await start();
		const signed = buildVerpAddress(MESSAGE_ID, RETURN_PATH_DOMAIN, VERP_KEY);
		expect(await deliver(port, `abuse@${RETURN_PATH_DOMAIN}`, forwardedOriginal(signed))).toMatch(
			/^250 /
		);
		expect(queuedEvents()).toEqual(['complained']);
		expect(mocks.queueConvexWebhook.mock.calls[0]![0]).toMatchObject({
			messageId: MESSAGE_ID,
			recipient: RECIPIENT,
			organizationId: 'org-send',
		});
	});

	it('does not read a forwarded original with a forged token as a complaint', async () => {
		const port = await start();
		const signed = buildVerpAddress(MESSAGE_ID, RETURN_PATH_DOMAIN, VERP_KEY);
		const forged = signed.replace(/(.)@/, (_m, last: string) => `${last === 'A' ? 'B' : 'A'}@`);
		expect(await deliver(port, `abuse@${RETURN_PATH_DOMAIN}`, forwardedOriginal(forged))).toMatch(
			/^250 /
		);
		expect(queuedEvents()).toEqual([]);
		expect(notifiedEvents().map((e) => e.event)).toEqual(['inbound.received']);
	});

	it('does not read a forward into an ordinary mailbox as a complaint', async () => {
		await setMailboxCache(redis as never, 'reader@team.example', {
			mailboxId: 'mbx_1',
			organizationId: 'org_team',
			usedBytes: 0,
		});
		const port = await start();
		const signed = buildVerpAddress(MESSAGE_ID, RETURN_PATH_DOMAIN, VERP_KEY);
		expect(await deliver(port, 'reader@team.example', forwardedOriginal(signed))).toMatch(/^250 /);
		expect(queuedEvents()).toEqual([]);
		expect(notifiedEvents().map((e) => e.event)).toEqual(['inbound.mailbox.received']);
	});

	it('counts a complaint whose provenance stays unknown', async () => {
		const port = await start();
		const before = (await fblComplaintsUnknownProvenanceTotal.get()).values.reduce(
			(sum, v) => sum + v.value,
			0
		);
		expect(
			await deliver(
				port,
				`postmaster@${RETURN_PATH_DOMAIN}`,
				arfReport(['Original-Rcpt-To: someone@example.org'])
			)
		).toMatch(/^250 /);
		const after = (await fblComplaintsUnknownProvenanceTotal.get()).values.reduce(
			(sum, v) => sum + v.value,
			0
		);
		expect(after - before).toBe(1);
		expect(mocks.queueConvexWebhook).not.toHaveBeenCalled();
	});
});
