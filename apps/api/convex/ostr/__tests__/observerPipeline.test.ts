/**
 * Observer mode end to end (plan §7.2 → §7.4 → §9.1).
 *
 * The properties under test are the ones that are expensive to get wrong: a
 * report is captured exactly once however many times a replayed message is
 * junked; an instance that is not eligible captures NOTHING; what reaches a log
 * is a signed pair `@owlat/ostr-core` accepts and can verify; a subject below
 * the k-floor is held rather than published; retention actually deletes; and no
 * reporter, recipient, mailbox or address appears anywhere in a published body.
 *
 * The k-thresholds are the SHIPPED ones — the package's test-only escape hatch
 * is deliberately not on the configuration path, so this suite provisions the
 * six mailboxes and twenty-four messages a real publishable window needs. That
 * is the point: a test that lowered the floor would prove nothing about the
 * deployment anyone runs.
 */

import { generateKeyPairSync } from 'node:crypto';
import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	generateEd25519KeyPair,
	validateAttestation,
	verifyAttestationSignature,
	type Attestation,
} from '@owlat/ostr-core';
import { buildEvidenceBundle, reportDedupeKey } from '@owlat/ostr-observer';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModules';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

const HOUR_MS = 60 * 60 * 1000;
/** A real 2048-bit RSA SPKI, base64 — `@owlat/ostr-core` parses the DER before
 *  it will log a key, so a placeholder string would silently emit nothing. */
const DKIM_PUBLIC_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
	.publicKey.export({ type: 'spki', format: 'der' })
	.toString('base64');
const KEYS = generateEd25519KeyPair();
const LOG_A = 'https://log-a.example/v1/attestations';
const LOG_B = 'https://log-b.example/v1/attestations';

/** Bodies posted to a log, in the order they were posted. */
let posted: Attestation[] = [];

function stubLogs(): void {
	posted = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: { body: string }) => {
			posted.push(JSON.parse(init.body) as Attestation);
			return new Response(JSON.stringify({ accepted: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		})
	);
}

function enableObserver(overrides: Record<string, string> = {}): void {
	vi.stubEnv('INSTANCE_SECRET', 'test-instance-secret');
	vi.stubEnv('OSTR_OBSERVER_ENABLED', 'true');
	vi.stubEnv('OSTR_OBSERVER_DOMAIN', 'mx.observer.example');
	vi.stubEnv('OSTR_OBSERVER_PRIVATE_KEY', KEYS.privateKey);
	vi.stubEnv('OSTR_LOG_URLS', `${LOG_A},${LOG_B}`);
	for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
}

type T = ReturnType<typeof convexTest>;

/** Run the actions the junk mutation scheduled. The advance-timers hook is a
 *  no-op on purpose: these are `runAfter(0)` real timers, and convex-test
 *  yields through the real event loop for exactly that case — installing fake
 *  timers here would stall the Node action's own `fetch` deadline instead. */
async function drainScheduler(t: T): Promise<void> {
	await t.finishAllScheduledFunctions(() => {});
}

interface Seeded {
	mailboxIds: Id<'mailboxes'>[];
	inboxIds: Id<'mailFolders'>[];
	threadIds: Id<'mailThreads'>[];
}

/** `count` active personal mailboxes, each with an Inbox, a Spam folder and a
 *  thread to hang messages on. */
async function seedMailboxes(t: T, count: number): Promise<Seeded> {
	const seeded: Seeded = { mailboxIds: [], inboxIds: [], threadIds: [] };
	await t.run(async (ctx) => {
		const now = Date.now();
		for (let i = 0; i < count; i++) {
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: `user-${i}`,
				organizationId: 'test-org',
				address: `user${i}@observer.example`,
				domain: 'observer.example',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			const folder = async (role: 'inbox' | 'spam') =>
				ctx.db.insert('mailFolders', {
					mailboxId,
					name: role,
					role,
					uidValidity: now,
					uidNext: 1,
					highestModseq: 1,
					totalCount: 0,
					unseenCount: 0,
					subscribed: true,
					createdAt: now,
					updatedAt: now,
				});
			const inboxId = await folder('inbox');
			await folder('spam');
			const threadId = await ctx.db.insert('mailThreads', {
				mailboxId,
				normalizedSubject: 'offer',
				participants: [`user${i}@observer.example`],
				messageCount: 0,
				unreadCount: 0,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now,
				firstMessageAt: now,
				latestSnippet: 'offer',
				latestFromAddress: 'sales@sender.example',
				latestSubject: 'offer',
				folderRoles: ['inbox'],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
			seeded.mailboxIds.push(mailboxId);
			seeded.inboxIds.push(inboxId);
			seeded.threadIds.push(threadId);
		}
	});
	return seeded;
}

/**
 * A DKIM-verified inbound message, as the delivery path would have left it.
 *
 * `receivedAt` is the SENDER's clock (`Date:` when the message carried one) and
 * `createdAt` is ours; they are the same instant unless a test says otherwise,
 * which is what lets the back-dating case below be written at all.
 */
async function deliver(
	t: T,
	seeded: Seeded,
	index: number,
	params: {
		signingDomain: string;
		rfc822MessageId: string;
		receivedAt: number;
		uid: number;
		createdAt?: number;
	}
): Promise<Id<'mailMessages'>> {
	return t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob(['raw']));
		return ctx.db.insert('mailMessages', {
			mailboxId: seeded.mailboxIds[index]!,
			folderId: seeded.inboxIds[index]!,
			uid: params.uid,
			modseq: params.uid,
			rfc822MessageId: params.rfc822MessageId,
			threadId: seeded.threadIds[index]!,
			fromAddress: `sales@${params.signingDomain}`,
			toAddresses: [`user${index}@observer.example`],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'offer',
			normalizedSubject: 'offer',
			snippet: 'offer',
			rawStorageId: storageId,
			rawSize: 3,
			attachments: [],
			hasAttachments: false,
			flagSeen: false,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			receivedAt: params.receivedAt,
			internalDate: params.receivedAt,
			spfResult: 'pass',
			dkimResult: 'pass',
			dmarcResult: 'pass',
			dkimSigningDomain: params.signingDomain,
			createdAt: params.createdAt ?? params.receivedAt,
			updatedAt: params.createdAt ?? params.receivedAt,
		});
	});
}

/** The evidence an observer-mode MTA would have captured for that message. */
function evidenceFor(rfc822MessageId: string, signingDomain: string, verifiedAt: string) {
	return {
		rawSignedHeaders: [
			{ name: 'From', raw: `From: Sales <sales@${signingDomain}>` },
			{ name: 'To', raw: 'To: user@observer.example' },
			{ name: 'Subject', raw: 'Subject: offer' },
			{ name: 'Date', raw: 'Date: Wed, 19 Aug 2026 09:14:02 +0000' },
			{ name: 'Message-ID', raw: `Message-ID: ${rfc822MessageId}` },
		],
		dkimSignatureHeader: `DKIM-Signature: v=1; a=rsa-sha256; d=${signingDomain}; s=sel1; h=from:to:subject:date:message-id; bh=2jmj7l5rSw0yVb/vlWAYkK/YBwk=; b=Zm9v`,
		dnsKeyRecordTxt: `v=DKIM1; k=rsa; p=${DKIM_PUBLIC_KEY}`,
		verificationVerdict: 'pass',
		verifiedAt,
		messageId: rfc822MessageId,
		bodyHash: `bh-${rfc822MessageId}`,
		signingDomain,
		selector: 'sel1',
		algorithm: 'rsa-sha256',
		keyBits: 2048,
		usesBodyLengthTag: false,
		signedHeaderNames: ['from', 'to', 'subject', 'date', 'message-id'],
	};
}

async function attachEvidence(
	t: T,
	messageId: Id<'mailMessages'>,
	mailboxId: Id<'mailboxes'>,
	rfc822MessageId: string,
	signingDomain: string,
	createdAt: number,
	overrides: Partial<ReturnType<typeof evidenceFor>> = {}
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('ostrEvidence', {
			messageId,
			mailboxId,
			evidence: {
				...evidenceFor(rfc822MessageId, signingDomain, new Date(createdAt).toISOString()),
				...overrides,
			},
			createdAt,
		});
	});
}

/** `count` active mailboxes backing DELIVERABILITY SEEDS — org infrastructure,
 *  not anybody's inbox. */
async function seedRobotMailboxes(t: T, count: number): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (let i = 0; i < count; i++) {
			await ctx.db.insert('mailboxes', {
				userId: `seed-user-${i}`,
				organizationId: 'test-org',
				address: `seed${i}@observer.example`,
				domain: 'observer.example',
				scope: 'seed',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

const queuedReports = (t: T) => t.run((ctx) => ctx.db.query('ostrReportQueue').collect());

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	stubLogs();
});

describe('junk action → report capture', () => {
	it('captures a report exactly once, however often the same message is junked', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxes(t, 6);
		const messageId = await deliver(t, seeded, 0, {
			signingDomain: 'sender.example',
			rfc822MessageId: '<replay-1@sender.example>',
			receivedAt: Date.now(),
			uid: 1,
		});
		await attachEvidence(
			t,
			messageId,
			seeded.mailboxIds[0]!,
			'<replay-1@sender.example>',
			'sender.example',
			Date.now()
		);

		await t.mutation(api.mail.messageActions.reportSpam, { messageIds: [messageId] });
		await drainScheduler(t);
		expect(await queuedReports(t)).toHaveLength(1);

		// "Not spam", then junk it again: the second report is the SAME message
		// (same Message-ID, same bh=), so §7.3 dedupe refuses it at capture.
		await t.mutation(api.mail.messageActions.notSpam, { messageIds: [messageId] });
		await t.mutation(api.mail.messageActions.reportSpam, { messageIds: [messageId] });
		await drainScheduler(t);
		expect(await queuedReports(t)).toHaveLength(1);
	});

	it('keys the dedupe and the bundle on the Message-ID VALUE, not the wire brackets', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxes(t, 6);
		const at = Date.now();
		const wire = '<brackets-1@sender.example>';
		const value = 'brackets-1@sender.example';
		const messageId = await deliver(t, seeded, 0, {
			signingDomain: 'sender.example',
			rfc822MessageId: wire,
			receivedAt: at,
			uid: 1,
		});
		await attachEvidence(t, messageId, seeded.mailboxIds[0]!, wire, 'sender.example', at);

		await t.mutation(api.mail.messageActions.reportSpam, { messageIds: [messageId] });
		await drainScheduler(t);
		const reports = await queuedReports(t);
		expect(reports).toHaveLength(1);

		// The wire carries the Message-ID as `parseMessage` yields it, brackets
		// intact, so the evidence correlates with the stored message. Both values
		// a SECOND implementation has to reproduce byte for byte are taken over
		// the VALUE, which is how `@owlat/ostr-observer` documents its inputs: the
		// §7.3 dedupe key, and the bundle hash a monitor recomputes from a
		// revealed bundle at challenge time. Recomputed here through the package
		// itself, exactly as that second implementation would.
		expect(reports[0]!.dedupeKey).toBe(
			reportDedupeKey({ messageId: value, bodyHash: `bh-${wire}` })
		);
		const expected = buildEvidenceBundle({
			...evidenceFor(wire, 'sender.example', new Date(at).toISOString()),
			messageId: value,
			verificationVerdict: 'pass',
		});
		expect(expected.ok).toBe(true);
		expect(reports[0]!.bundleHash).toBe(expected.ok ? expected.bundleHash : undefined);
	});

	it('captures nothing from an `l=` signature, which §7.1 says is not evidence', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxes(t, 6);
		const messageId = await deliver(t, seeded, 0, {
			signingDomain: 'sender.example',
			rfc822MessageId: '<lax-1@sender.example>',
			receivedAt: Date.now(),
			uid: 1,
		});
		// A body-length tag lets an attacker append content the signature does not
		// cover, so the bundle proves nothing about what the recipient read.
		await attachEvidence(
			t,
			messageId,
			seeded.mailboxIds[0]!,
			'<lax-1@sender.example>',
			'sender.example',
			Date.now(),
			{ usesBodyLengthTag: true }
		);

		expect(
			await t.action(internal.ostr.observer.captureSpamReports, {
				reports: [{ messageId, mailboxId: seeded.mailboxIds[0]! }],
			})
		).toEqual([{ captured: false, reason: 'inadmissible' }]);
		expect(await queuedReports(t)).toHaveLength(0);
	});

	it('captures nothing from a verdict that is not a pass', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxes(t, 6);
		const messageId = await deliver(t, seeded, 0, {
			signingDomain: 'sender.example',
			rfc822MessageId: '<unknown-verdict@sender.example>',
			receivedAt: Date.now(),
			uid: 1,
		});
		// An unrecognised verdict narrows to `permerror`, never to a pass: an
		// unknown answer must reach the admissibility check as a non-pass rather
		// than as a missing field.
		await attachEvidence(
			t,
			messageId,
			seeded.mailboxIds[0]!,
			'<unknown-verdict@sender.example>',
			'sender.example',
			Date.now(),
			{ verificationVerdict: 'something-else' }
		);

		expect(
			await t.action(internal.ostr.observer.captureSpamReports, {
				reports: [{ messageId, mailboxId: seeded.mailboxIds[0]! }],
			})
		).toEqual([{ captured: false, reason: 'inadmissible' }]);
		expect(await queuedReports(t)).toHaveLength(0);
	});

	it('queues nothing for "Not spam" on its own', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxes(t, 6);
		const messageId = await deliver(t, seeded, 0, {
			signingDomain: 'sender.example',
			rfc822MessageId: '<rescue-1@sender.example>',
			receivedAt: Date.now(),
			uid: 1,
		});
		await attachEvidence(
			t,
			messageId,
			seeded.mailboxIds[0]!,
			'<rescue-1@sender.example>',
			'sender.example',
			Date.now()
		);

		// A rescue is a statement about OUR filter, not about the sender, and the
		// spec has no attestation kind that means "this was fine".
		await t.mutation(api.mail.messageActions.notSpam, { messageIds: [messageId] });
		await drainScheduler(t);
		expect(await queuedReports(t)).toHaveLength(0);
	});

	it('never reaches an attestation path with a raw mailbox id', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxes(t, 6);
		const messageId = await deliver(t, seeded, 0, {
			signingDomain: 'sender.example',
			rfc822MessageId: '<token-1@sender.example>',
			receivedAt: Date.now(),
			uid: 1,
		});
		await attachEvidence(
			t,
			messageId,
			seeded.mailboxIds[0]!,
			'<token-1@sender.example>',
			'sender.example',
			Date.now()
		);
		await t.mutation(api.mail.messageActions.reportSpam, { messageIds: [messageId] });
		await drainScheduler(t);

		const [report] = await queuedReports(t);
		expect(report).toBeDefined();
		expect(report!.reporterToken).toMatch(/^[0-9a-f]{64}$/);
		expect(report!.reporterToken).not.toContain(seeded.mailboxIds[0]!);
		expect(JSON.stringify(report)).not.toContain('user0@observer.example');
	});
});

describe('the §7.4 eligibility gate', () => {
	it('does not count deliverability seeds toward the mailbox floor', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		// Four people and two robots. Six ACTIVE mailbox rows, which would clear
		// the floor — but a seed is org infrastructure, and letting one count
		// would mean an operator could clear a threshold that exists to protect
		// PEOPLE by provisioning more robots.
		const seeded = await seedMailboxes(t, 4);
		await seedRobotMailboxes(t, 2);
		const messageId = await deliver(t, seeded, 0, {
			signingDomain: 'sender.example',
			rfc822MessageId: '<seeded-1@sender.example>',
			receivedAt: Date.now(),
			uid: 1,
		});
		await attachEvidence(
			t,
			messageId,
			seeded.mailboxIds[0]!,
			'<seeded-1@sender.example>',
			'sender.example',
			Date.now()
		);

		expect(
			await t.action(internal.ostr.observer.captureSpamReports, {
				reports: [{ messageId, mailboxId: seeded.mailboxIds[0]! }],
			})
		).toEqual([{ captured: false, reason: 'below-mailbox-threshold' }]);
		expect(await queuedReports(t)).toHaveLength(0);
	});

	it('captures nothing below the mailbox floor', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		// Four mailboxes: under the packaged floor, and `OSTR_MIN_MAILBOXES` can
		// only raise it, so there is no configuration that admits this instance.
		const seeded = await seedMailboxes(t, 4);
		const messageId = await deliver(t, seeded, 0, {
			signingDomain: 'sender.example',
			rfc822MessageId: '<small-1@sender.example>',
			receivedAt: Date.now(),
			uid: 1,
		});
		await attachEvidence(
			t,
			messageId,
			seeded.mailboxIds[0]!,
			'<small-1@sender.example>',
			'sender.example',
			Date.now()
		);

		const outcome = await t.action(internal.ostr.observer.captureSpamReports, {
			reports: [{ messageId, mailboxId: seeded.mailboxIds[0]! }],
		});
		expect(outcome).toEqual([{ captured: false, reason: 'below-mailbox-threshold' }]);
		expect(await queuedReports(t)).toHaveLength(0);
	});

	it('captures nothing with observer mode off, however many mailboxes there are', async () => {
		enableObserver({ OSTR_OBSERVER_ENABLED: 'false' });
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxes(t, 12);
		const messageId = await deliver(t, seeded, 0, {
			signingDomain: 'sender.example',
			rfc822MessageId: '<off-1@sender.example>',
			receivedAt: Date.now(),
			uid: 1,
		});
		await attachEvidence(
			t,
			messageId,
			seeded.mailboxIds[0]!,
			'<off-1@sender.example>',
			'sender.example',
			Date.now()
		);

		await t.mutation(api.mail.messageActions.reportSpam, { messageIds: [messageId] });
		await drainScheduler(t);
		expect(await queuedReports(t)).toHaveLength(0);

		// Even called directly, the action refuses: the mutation's env check is a
		// cheap short-circuit, not the gate.
		expect(
			await t.action(internal.ostr.observer.captureSpamReports, {
				reports: [{ messageId, mailboxId: seeded.mailboxIds[0]! }],
			})
		).toEqual([{ captured: false, reason: 'disabled' }]);
	});

	it('raises the floor when OSTR_MIN_MAILBOXES asks for more', async () => {
		enableObserver({ OSTR_MIN_MAILBOXES: '20' });
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxes(t, 6);
		const messageId = await deliver(t, seeded, 0, {
			signingDomain: 'sender.example',
			rfc822MessageId: '<raised-1@sender.example>',
			receivedAt: Date.now(),
			uid: 1,
		});
		await attachEvidence(
			t,
			messageId,
			seeded.mailboxIds[0]!,
			'<raised-1@sender.example>',
			'sender.example',
			Date.now()
		);
		expect(
			await t.action(internal.ostr.observer.captureSpamReports, {
				reports: [{ messageId, mailboxId: seeded.mailboxIds[0]! }],
			})
		).toEqual([{ captured: false, reason: 'below-mailbox-threshold' }]);
	});
});

/**
 * One window's worth of traffic: 24 DKIM-verified messages from `sender.example`
 * across all six mailboxes (clearing the message and distinct-recipient floors),
 * 2 from `quiet.example` (clearing neither), and three reports about
 * `sender.example` from three different mailboxes.
 */
async function seedPublishableWindow(t: T): Promise<{ seeded: Seeded; windowToMs: number }> {
	const seeded = await seedMailboxes(t, 6);
	const windowToMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
	const receivedAt = windowToMs - 30 * 60 * 1000;

	let uid = 1;
	for (let i = 0; i < 24; i++) {
		const mailbox = i % 6;
		const rfc822MessageId = `<bulk-${i}@sender.example>`;
		const messageId = await deliver(t, seeded, mailbox, {
			signingDomain: 'sender.example',
			rfc822MessageId,
			receivedAt,
			uid: uid++,
		});
		if (i < 3) {
			await attachEvidence(
				t,
				messageId,
				seeded.mailboxIds[mailbox]!,
				rfc822MessageId,
				'sender.example',
				receivedAt
			);
			// Three reports from three DIFFERENT mailboxes: the k-floor counts
			// distinct reporters, not reports.
			await t.action(internal.ostr.observer.captureSpamReports, {
				reports: [{ messageId, mailboxId: seeded.mailboxIds[mailbox]! }],
			});
		}
	}

	for (let i = 0; i < 2; i++) {
		await deliver(t, seeded, i, {
			signingDomain: 'quiet.example',
			rfc822MessageId: `<quiet-${i}@quiet.example>`,
			receivedAt,
			uid: uid++,
		});
	}
	return { seeded, windowToMs };
}

describe('window close → signed publication', () => {
	it('publishes a traffic-summary + spam-report-batch pair the spec accepts', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		await seedPublishableWindow(t);
		expect(await queuedReports(t)).toHaveLength(3);

		const result = await t.action(internal.ostr.window.closeWindow, {});
		expect(result.skipped).toBeUndefined();

		// Two logs × the attestations, so each document appears twice.
		const kinds = posted.map((attestation) => attestation.kind);
		expect(kinds.filter((kind) => kind === 'traffic-summary')).toHaveLength(2);
		expect(kinds.filter((kind) => kind === 'spam-report-batch')).toHaveLength(2);
		expect(kinds.filter((kind) => kind === 'key-observation')).toHaveLength(2);

		for (const attestation of posted) {
			expect(validateAttestation(attestation).ok).toBe(true);
			expect(verifyAttestationSignature(attestation, KEYS.publicKey)).toBe(true);
			expect(attestation.observer).toBe('mx.observer.example');
		}

		const summary = posted.find((a) => a.kind === 'traffic-summary');
		const batch = posted.find((a) => a.kind === 'spam-report-batch');
		expect(summary?.subject).toEqual({ domain: 'sender.example' });
		expect(batch?.subject).toEqual({ domain: 'sender.example' });
		// §7.3: the batch and its denominator cover the same window.
		expect(batch?.window).toEqual(summary?.window);
		expect(batch?.body).toMatchObject({ reports: 3 });

		// The committed reports are stamped, not deleted: they are still the
		// dedupe memory until retention takes them.
		const reports = await queuedReports(t);
		expect(reports).toHaveLength(3);
		expect(reports.every((report) => report.emittedAt !== undefined)).toBe(true);
	});

	it('holds a subject below the k-floor instead of publishing it', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		await seedPublishableWindow(t);
		await t.action(internal.ostr.window.closeWindow, {});

		// `quiet.example` sent 2 messages to 2 mailboxes — under both traffic
		// floors — so nothing about it may leave this instance.
		expect(posted.some((a) => a.subject.domain === 'quiet.example')).toBe(false);
		expect(JSON.stringify(posted)).not.toContain('quiet.example');

		// …and it is RETAINED, not dropped: the held counters are in the
		// serialized accumulator, waiting for a wider window.
		const state = await t.run((ctx) => ctx.db.query('ostrObserverState').first());
		expect(state?.accumulatorState).toContain('quiet.example');
	});

	it('publishes no reporter, recipient, mailbox or address in any body', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		const { seeded } = await seedPublishableWindow(t);
		await t.action(internal.ostr.window.closeWindow, {});
		expect(posted.length).toBeGreaterThan(0);

		const reports = await queuedReports(t);
		const wire = JSON.stringify(posted);
		for (const mailboxId of seeded.mailboxIds) expect(wire).not.toContain(mailboxId);
		for (let i = 0; i < seeded.mailboxIds.length; i++) {
			expect(wire).not.toContain(`user${i}@observer.example`);
			expect(wire).not.toContain(`user-${i}`);
		}
		// Not even the SALTED tokens: reporters are counted and discarded, and
		// recipients only ever become a log-scale bucket.
		for (const report of reports) expect(wire).not.toContain(report.reporterToken);
		// The signed headers stay home: a bundle's Subject/To are exactly what a
		// public record may never carry, and only the bundle's HASH is committed.
		expect(wire).not.toContain('Subject');
		expect(wire).not.toContain('sales@sender.example');
	});

	it('records what each log accepted so a failed submission can be retried', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		await seedPublishableWindow(t);
		// One log is down for this window.
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init: { body: string }) => {
				if (url === LOG_B) throw new Error('connection refused');
				posted.push(JSON.parse(init.body) as Attestation);
				return new Response('{}', { status: 200 });
			})
		);

		await t.action(internal.ostr.window.closeWindow, {});
		const ledger = await t.run((ctx) => ctx.db.query('ostrSubmissionLog').collect());
		expect(ledger.length).toBeGreaterThan(0);
		for (const row of ledger) {
			expect(row.acceptedLogUrls).toEqual([LOG_A]);
			expect(row.pendingLogUrls).toEqual([LOG_B]);
			expect(row.isSettled).toBe(false);
		}

		// Next window, the log is back: the backlog is re-posted and settles.
		stubLogs();
		await t.action(internal.ostr.window.closeWindow, {});
		const settled = await t.run((ctx) => ctx.db.query('ostrSubmissionLog').collect());
		for (const row of settled.filter((r) => r.attempts > 1)) {
			expect(row.pendingLogUrls).toEqual([]);
			expect(row.isSettled).toBe(true);
		}
	});

	it('returns "disabled" without touching the roster or the run state', async () => {
		enableObserver({ OSTR_OBSERVER_ENABLED: 'false' });
		const t = convexTest(schema, modules);
		await seedPublishableWindow(t);

		// The shipped default, firing hourly on every deployment: the opt-in is
		// judged before the roster is enumerated, so the tick costs one env read.
		const result = await t.action(internal.ostr.window.closeWindow, {});
		expect(result).toEqual({ skipped: 'disabled' });
		expect(posted).toHaveLength(0);
		// No watermark either — a disabled instance must not consume windows it
		// never observed, or the hour it is switched on starts from a lie.
		expect(await t.run((ctx) => ctx.db.query('ostrObserverState').first())).toBeNull();
	});

	it('aggregates and holds, but publishes nothing, without a signing identity', async () => {
		enableObserver({ OSTR_OBSERVER_PRIVATE_KEY: '' });
		const t = convexTest(schema, modules);
		await seedPublishableWindow(t);

		const result = await t.action(internal.ostr.window.closeWindow, {});
		expect(result.skipped).toBe('not-configured');
		expect(posted).toHaveLength(0);
		// The window still closed and the reports are still queued, so nothing is
		// lost by configuring the key later.
		const reports = await queuedReports(t);
		expect(reports.every((report) => report.emittedAt === undefined)).toBe(true);
		// And the TRAFFIC is held too, which is the half that is easy to destroy:
		// emitting consumes the subjects it emits, so a pass that emitted before
		// discovering it could not sign would throw away exactly the counters that
		// cleared the floor. `sender.example` is still in the accumulator, and the
		// window it will eventually claim reaches back to this one.
		const state = await t.run((ctx) => ctx.db.query('ostrObserverState').first());
		expect(state?.accumulatorState).toContain('sender.example');
		expect(state?.unpublishedFrom).toBe(result.windowFrom);
	});

	it("counts traffic on the receiver clock, not the sender's Date: header", async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxes(t, 6);
		const windowToMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
		const createdAt = windowToMs - 30 * 60 * 1000;
		// Every message claims to have been sent a year ago. If the denominator
		// ranged on that, one header would drop this sender out of every traffic
		// summary — and with no summary there is no batch to pair a report with
		// (§7.3), so its complaints would sit queued until retention deleted them.
		const backDated = createdAt - 365 * 24 * HOUR_MS;
		for (let i = 0; i < 24; i++) {
			await deliver(t, seeded, i % 6, {
				signingDomain: 'backdater.example',
				rfc822MessageId: `<back-${i}@backdater.example>`,
				receivedAt: backDated,
				uid: i + 1,
				createdAt,
			});
		}

		await t.action(internal.ostr.window.closeWindow, {});
		const summary = posted.find((a) => a.subject.domain === 'backdater.example');
		expect(summary?.kind).toBe('traffic-summary');
		expect(summary?.body).toMatchObject({ messages: 24 });
	});

	it('retains the ordered commitment behind every published batch', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		await seedPublishableWindow(t);
		await t.action(internal.ostr.window.closeWindow, {});

		const batch = posted.find((a) => a.kind === 'spam-report-batch');
		expect(batch).toBeDefined();
		const commitments = await t.run((ctx) => ctx.db.query('ostrBatchCommitments').collect());
		expect(commitments).toHaveLength(1);
		const retained = commitments[0]!;
		// §7.2.4: an opening names an index into exactly this list, and the list
		// cannot be reconstructed from the published root once the batch is out.
		expect(retained.commitmentHex).toBe((batch!.body as { commitment: string }).commitment);
		expect(retained.bundleHashes).toHaveLength(3);
		expect(retained.subjectDomain).toBe('sender.example');
		expect({ from: retained.windowFrom, to: retained.windowTo }).toEqual(batch!.window);

		// Every committed report points back at its batch and at the message whose
		// bundle it committed, so an opening is two indexed reads, not a re-hash
		// of everything retained.
		const reports = await queuedReports(t);
		for (const report of reports) {
			expect(report.batchId).toBe(retained._id);
			expect(retained.bundleHashes).toContain(report.bundleHash);
			expect(report.messageId).toBeDefined();
		}
	});

	it('records a pending log, not an acceptance, when a log answers 400', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		await seedPublishableWindow(t);
		// A log that REJECTS is not a log that accepted. `submitAll` reports
		// whatever the poster resolves with, so a poster that resolved here would
		// make the ledger claim an acceptance that never happened.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{"error":"bad request"}', { status: 400 }))
		);

		await t.action(internal.ostr.window.closeWindow, {});
		const ledger = await t.run((ctx) => ctx.db.query('ostrSubmissionLog').collect());
		expect(ledger.length).toBeGreaterThan(0);
		for (const row of ledger) {
			expect(row.acceptedLogUrls).toEqual([]);
			expect(row.pendingLogUrls).toEqual([LOG_A, LOG_B]);
			expect(row.isSettled).toBe(false);
			expect(row.lastError).toContain('400');
		}
	});

	it('gives up on a submission no log will ever take, instead of retrying forever', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		await seedMailboxes(t, 6);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('getaddrinfo ENOTFOUND log-typo.example');
			})
		);
		// One attempt short of the cap: an unsettled row is never pruned and only
		// the oldest are ever retried, so a decommissioned log would otherwise grow
		// the table forever while starving everything behind it.
		const rowId = await t.run((ctx) =>
			ctx.db.insert('ostrSubmissionLog', {
				kind: 'traffic-summary',
				subject: 'sender.example',
				attestationJson: '{"v":1,"kind":"traffic-summary"}',
				acceptedLogUrls: [],
				pendingLogUrls: [LOG_B],
				attempts: 11,
				isSettled: false,
				createdAt: Date.now() - HOUR_MS,
				updatedAt: Date.now() - HOUR_MS,
			})
		);

		await t.action(internal.ostr.window.closeWindow, {});
		const row = await t.run((ctx) => ctx.db.get(rowId));
		expect(row?.attempts).toBe(12);
		expect(row?.isSettled).toBe(true);
		expect(row?.isAbandoned).toBe(true);
		// The record of what never arrived is kept, not erased — it is the one
		// copy an operator can audit before retention takes it.
		expect(row?.pendingLogUrls).toEqual([LOG_B]);
		expect(row?.lastError).toContain('ENOTFOUND');
	});
});

describe('retention (§7.2)', () => {
	it('deletes evidence, captured reports and settled submissions past the cutoff', async () => {
		enableObserver();
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxes(t, 6);
		const stale = Date.now() - 100 * 24 * 60 * 60 * 1000;

		const oldMessage = await deliver(t, seeded, 0, {
			signingDomain: 'sender.example',
			rfc822MessageId: '<old@sender.example>',
			receivedAt: stale,
			uid: 1,
		});
		await attachEvidence(
			t,
			oldMessage,
			seeded.mailboxIds[0]!,
			'<old@sender.example>',
			'sender.example',
			stale
		);
		const freshMessage = await deliver(t, seeded, 1, {
			signingDomain: 'sender.example',
			rfc822MessageId: '<fresh@sender.example>',
			receivedAt: Date.now(),
			uid: 2,
		});
		await attachEvidence(
			t,
			freshMessage,
			seeded.mailboxIds[1]!,
			'<fresh@sender.example>',
			'sender.example',
			Date.now()
		);
		await t.run(async (ctx) => {
			await ctx.db.insert('ostrReportQueue', {
				subjectDomain: 'sender.example',
				bundleHash: 'a'.repeat(64),
				reporterToken: 'b'.repeat(64),
				dedupeKey: 'c'.repeat(64),
				capturedAt: new Date(stale).toISOString(),
				emittedAt: stale,
				createdAt: stale,
			});
			await ctx.db.insert('ostrSubmissionLog', {
				kind: 'traffic-summary',
				subject: 'sender.example',
				attestationJson: '{}',
				acceptedLogUrls: [LOG_A],
				pendingLogUrls: [],
				attempts: 1,
				isSettled: true,
				createdAt: stale,
				updatedAt: stale,
			});
			// An UNSETTLED submission of the same age stays: abandoning it would
			// quietly drop evidence this observer said it had published.
			await ctx.db.insert('ostrSubmissionLog', {
				kind: 'traffic-summary',
				subject: 'other.example',
				attestationJson: '{}',
				acceptedLogUrls: [],
				pendingLogUrls: [LOG_B],
				attempts: 3,
				isSettled: false,
				createdAt: stale,
				updatedAt: stale,
			});
		});

		await t.mutation(internal.ostr.retention.pruneObserverData, {});

		const evidence = await t.run((ctx) => ctx.db.query('ostrEvidence').collect());
		expect(evidence).toHaveLength(1);
		expect(evidence[0]!.messageId).toBe(freshMessage);
		expect(await queuedReports(t)).toHaveLength(0);
		const ledger = await t.run((ctx) => ctx.db.query('ostrSubmissionLog').collect());
		expect(ledger).toHaveLength(1);
		expect(ledger[0]!.isSettled).toBe(false);
	});

	it('prunes even after observer mode is switched off', async () => {
		enableObserver({ OSTR_OBSERVER_ENABLED: 'false' });
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxes(t, 6);
		const stale = Date.now() - 100 * 24 * 60 * 60 * 1000;
		const messageId = await deliver(t, seeded, 0, {
			signingDomain: 'sender.example',
			rfc822MessageId: '<abandoned@sender.example>',
			receivedAt: stale,
			uid: 1,
		});
		await attachEvidence(
			t,
			messageId,
			seeded.mailboxIds[0]!,
			'<abandoned@sender.example>',
			'sender.example',
			stale
		);

		await t.mutation(internal.ostr.retention.pruneObserverData, {});
		expect(await t.run((ctx) => ctx.db.query('ostrEvidence').collect())).toHaveLength(0);
	});
});
