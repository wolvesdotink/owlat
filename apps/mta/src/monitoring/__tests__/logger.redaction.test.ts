/**
 * The MTA's pino logger de-identifies correspondent addresses and subjects
 * centrally, via `redact` — so that a `logger.info({ rcptTo }, '…')` written
 * next year is safe without its author knowing this rule exists. That makes the
 * config, not the call sites, the thing worth testing.
 *
 * pino exposes no way to read a live logger's redaction back, and it writes to
 * fd 1 rather than a stream a test can hand it, so the assertion is made where
 * it is actually true: a child process imports the real `logger` module and its
 * stdout is parsed.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Log `payload` through the real logger in a child process; return the JSON line. */
function logLine(payload: Record<string, unknown>): Record<string, unknown> {
	const script = `import { logger } from './src/monitoring/logger.ts';
logger.info(${JSON.stringify(payload)}, 'test line');`;
	const stdout = execFileSync('bun', ['-e', script], {
		cwd: appRoot,
		encoding: 'utf8',
		env: { ...process.env, NODE_ENV: 'production' },
	});
	const line = stdout.trim().split('\n').at(-1) ?? '';
	return JSON.parse(line) as Record<string, unknown>;
}

describe('mta logger redaction', () => {
	it('de-identifies envelope addresses while keeping the domain', () => {
		const out = logLine({ rcptTo: 'marcel@example.com', from: 'sender@other.test' });
		expect(out['rcptTo']).toMatch(/^redacted-[0-9a-f]{12}@example\.com$/);
		expect(out['from']).toMatch(/^redacted-[0-9a-f]{12}@other\.test$/);
		expect(JSON.stringify(out)).not.toContain('marcel');
		expect(JSON.stringify(out)).not.toContain('sender@');
	});

	it('replaces a subject with its length and digest', () => {
		const out = logLine({ subject: 'Re: invoice 4012 overdue' });
		expect(out['subject']).toMatch(/^\[subject len=24 [0-9a-f]{12}\]$/);
		expect(JSON.stringify(out)).not.toContain('invoice');
	});

	it('redacts a nested payload one level down', () => {
		const out = logLine({ job: { to: 'marcel@example.com', messageId: 'm-1' } });
		const job = out['job'] as Record<string, unknown>;
		expect(job['to']).toMatch(/^redacted-[0-9a-f]{12}@example\.com$/);
		expect(job['messageId']).toBe('m-1');
	});

	it('leaves a non-address value under an address-shaped key readable', () => {
		const out = logLine({ to: 'deferred', messageId: 'm-1', orgId: 'org_1' });
		expect(out['to']).toBe('deferred');
		expect(out['messageId']).toBe('m-1');
		expect(out['orgId']).toBe('org_1');
	});

	it('correlates two lines about the same recipient', () => {
		const first = logLine({ rcptTo: 'marcel@example.com' });
		const second = logLine({ rcptTo: 'MARCEL@Example.com' });
		expect(first['rcptTo']).toBe(second['rcptTo']);
	});
});
