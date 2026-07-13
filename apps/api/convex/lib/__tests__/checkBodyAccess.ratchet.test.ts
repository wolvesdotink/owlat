/**
 * Self-test for the `scripts/check-body-access.sh` ratchet: a fixture tree with
 * a body-body read must fail it, a clean tree must pass. This is the "ratchet
 * script self-test" named on the E8a piece card — it guards the guard, so a
 * future edit that neuters the grep is caught by CI.
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
	'check-body-access.sh'
);

/** Run the ratchet against `root`. Returns the process exit code (0 = pass). */
function runRatchet(root: string): number {
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
	workDir = mkdtempSync(join(tmpdir(), 'body-access-ratchet-'));
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe('check-body-access.sh ratchet', () => {
	it('passes a tree that reads bodies only through the accessor', () => {
		const root = join(workDir, 'clean');
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, 'clean.ts'),
			[
				"const a = mailMessageInlineBody(row).text ?? '';",
				'const b = inboundMessageBody(msg).html;',
				'const parsed = parseUnifiedMessageContent(u.content);',
				// allowed receivers (mutation args / parser output) are ingest-boundary:
				'const c = args.textBody;',
				'const d = params.textBodyInline;',
				'const e = input.htmlBody;',
				'const f = mp.htmlBody;',
				// object-literal keys are writes, not reads:
				"const g = { textBody: 'x', htmlBody: 'y', textBodyInline: 'z' };",
				'',
			].join('\n')
		);
		expect(runRatchet(root)).toBe(0);
	});

	it('fails a tree with a stored-row body-field dot-read', () => {
		const root = join(workDir, 'bad-read');
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, 'reader.ts'), "const body = row.textBodyInline ?? '';\n");
		expect(runRatchet(root)).toBe(1);
	});

	it('fails a tree with an inboundMessages inline body dot-read', () => {
		const root = join(workDir, 'bad-inbound');
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, 'reader.ts'),
			'const t = message.textBody;\nconst h = message.htmlBody;\n'
		);
		expect(runRatchet(root)).toBe(1);
	});

	it('fails a tree with a body-blob content read', () => {
		const root = join(workDir, 'bad-blob');
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, 'blob.ts'),
			'const blob = await ctx.storage.get(msg.textBodyStorageId);\n'
		);
		expect(runRatchet(root)).toBe(1);
	});

	it('does not confuse a *BodyStorageId handle passed to getUrl with a content read', () => {
		const root = join(workDir, 'geturl');
		mkdirSync(root, { recursive: true });
		// getUrl returns a URL, not body bytes — this is NOT a violation.
		writeFileSync(
			join(root, 'url.ts'),
			'const url = await ctx.storage.getUrl(message.textBodyStorageId);\n'
		);
		expect(runRatchet(root)).toBe(0);
	});
});
