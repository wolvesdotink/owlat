/**
 * Self-test for the `scripts/check-log-pii.sh` build gate: a log call that puts
 * a correspondent address or a subject into the process log must fail, and a
 * redacted, justified, or non-address field must pass. It guards the guard — a
 * future edit that neuters the awk is caught by CI.
 *
 * The script takes an optional scan root so the fixtures below run against a
 * throwaway tree; the final case asserts the real convex/ tree is still clean
 * (the gate has a baseline of zero, so "clean" is the only passing state).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..',
	'scripts',
	'check-log-pii.sh'
);

/** Run the gate over `root`. Returns the exit code. */
function runGate(root: string): number {
	try {
		execFileSync('bash', [scriptPath, root], { encoding: 'utf8', stdio: 'pipe' });
		return 0;
	} catch (err) {
		const status = (err as { status?: number }).status;
		return typeof status === 'number' ? status : 1;
	}
}

let workDir: string;

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), 'log-pii-gate-'));
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

/** Write a single fixture file into a fresh dir and return that dir. */
function fixture(name: string, lines: string[]): string {
	const root = join(workDir, name);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, 'log.ts'), `${lines.join('\n')}\n`);
	return root;
}

describe('check-log-pii.sh gate', () => {
	it('fails a multi-line payload carrying from / to / subject', () => {
		const root = fixture('bad-envelope', [
			"logWarn('[Inbound Email] duplicate delivery', {",
			'	messageId: args.messageId,',
			'	from: args.from,',
			'	to: args.to,',
			'	subject: args.subject,',
			'});',
		]);
		expect(runGate(root)).toBe(1);
	});

	it('fails a single-line payload', () => {
		const root = fixture('bad-inline', ["logInfo('sent', { recipient: args.recipient });"]);
		expect(runGate(root)).toBe(1);
	});

	it('fails a raw console call the same way as the runtimeLog wrappers', () => {
		const root = fixture('bad-console', ["console.warn('bounced', { rcptTo: job.rcptTo });"]);
		expect(runGate(root)).toBe(1);
	});

	it('passes when the values go through the redaction helpers', () => {
		const root = fixture('redacted', [
			"logWarn('[Inbound Email] duplicate delivery', {",
			'	messageId: args.messageId,',
			'	from: redactEmailAddress(args.from),',
			'	subject: redactSubject(args.subject),',
			'});',
		]);
		expect(runGate(root)).toBe(0);
	});

	it('passes qualified names that are a domain, a count, an id or a digest', () => {
		const root = fixture('qualified', [
			"logInfo('delivered', {",
			'	fromDomain: domainOf(args.from),',
			'	toCount: recipients.length,',
			'	senderId: contact._id,',
			'	recipientHash: digest,',
			'	addressCount: 3,',
			'});',
		]);
		expect(runGate(root)).toBe(0);
	});

	it('passes a call carrying an inline // log-pii-safe: justification', () => {
		const root = fixture('justified-inline', [
			"logInfo('webhook received', {",
			'	// log-pii-safe: the provider’s routing label, not a mailbox',
			'	from: payload.queueName,',
			'});',
		]);
		expect(runGate(root)).toBe(0);
	});

	it('passes a call whose // log-pii-safe: note sits above it', () => {
		const root = fixture('justified-above', [
			'// log-pii-safe: header NAMES, never their values',
			"logInfo('headers dropped', { from: HEADER_FROM, subject: HEADER_SUBJECT });",
		]);
		expect(runGate(root)).toBe(0);
	});

	it('does not leak a // log-pii-safe: note onto a later call', () => {
		const root = fixture('no-leak', [
			'// log-pii-safe: this one is a label',
			"logInfo('a', { from: label });",
			'',
			'const x = 1;',
			'',
			"logInfo('b', { from: args.from });",
		]);
		expect(runGate(root)).toBe(1);
	});

	it('ignores object keys outside a log call', () => {
		const root = fixture('not-a-log', [
			'await ctx.runMutation(internal.inbox.transition, {',
			'	inboundMessageId,',
			"	to: 'archived',",
			'	from: args.from,',
			'});',
		]);
		expect(runGate(root)).toBe(0);
	});

	it('does not carry a call span past its closing line', () => {
		const root = fixture('span-ends', [
			"logInfo('stored', { messageId });",
			'const envelope = {',
			'	from: args.from,',
			'	subject: args.subject,',
			'};',
		]);
		expect(runGate(root)).toBe(0);
	});

	it('skips test files and generated code', () => {
		const root = join(workDir, 'skipped');
		mkdirSync(join(root, '_generated'), { recursive: true });
		mkdirSync(join(root, '__tests__'), { recursive: true });
		writeFileSync(join(root, 'thing.test.ts'), "logInfo('x', { from: args.from });\n");
		writeFileSync(join(root, '_generated', 'api.ts'), "logInfo('x', { from: args.from });\n");
		writeFileSync(join(root, '__tests__', 'thing.ts'), "logInfo('x', { from: args.from });\n");
		expect(runGate(root)).toBe(0);
	});

	// Every case above greps a throwaway fixture tree; this one greps the whole
	// real convex/ tree and takes seconds rather than milliseconds — give it the
	// same headroom checkTokenRedaction.ratchet.test.ts needed on a loaded CI
	// runner rather than leaving the release gate to lose a coin flip.
	it('passes the real convex tree at its baseline of zero', () => {
		expect(runGate('convex')).toBe(0);
	}, 120_000);
});
