/**
 * Conformance for the crypto-primitives gate (`scripts/check-crypto-primitives.sh`).
 *
 * The cases run the REAL script against throwaway trees and pin what it
 * reports: a Web Crypto HMAC key import or HMAC sign, or a node:crypto
 * `timingSafeEqual(` call, anywhere under apps/ or packages/ outside the
 * sanctioned modules, tests and generated code.
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GATE = 'scripts/check-crypto-primitives.sh';
const run = promisify(execFile);

const SANCTIONED = {
	'apps/api/convex/lib/crypto.ts': [
		"const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash }, false, ['sign']);",
		"const sig = await crypto.subtle.sign('HMAC', key, data);",
		'',
	].join('\n'),
	'packages/shared/src/constantTimeEqual.ts':
		'export const constantTimeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));\n',
	'apps/convex-fn-proxy/src/allowlist.ts': 'return timingSafeEqual(hashA, hashB);\n',
};

const OPEN_CODED_HMAC = [
	'async function hmacHex(secret: string, data: string) {',
	'\tconst key = await crypto.subtle.importKey(',
	"\t\t'raw',",
	'\t\tnew TextEncoder().encode(secret),',
	"\t\t{ name: 'HMAC', hash: 'SHA-256' },",
	'\t\tfalse,',
	"\t\t['sign']",
	'\t);',
	"\treturn crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));",
	'}',
	'',
].join('\n');

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

async function gate(
	files: Record<string, string>,
	{ args = [], omit = [] }: { args?: string[]; omit?: string[] } = {}
): Promise<{ code: number; stdout: string }> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-crypto-gate-'));
	roots.push(root);
	for (const [path, contents] of Object.entries({ ...SANCTIONED, ...files })) {
		if (omit.includes(path)) continue;
		const target = join(root, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf8');
	}
	await mkdir(join(root, 'scripts'), { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, GATE), join(root, GATE));
	try {
		const { stdout } = await run('bash', [GATE, ...args], { cwd: root });
		return { code: 0, stdout };
	} catch (error) {
		const failed = error as { code: number; stdout: string };
		return { code: failed.code, stdout: failed.stdout };
	}
}

describe('crypto-primitives gate', () => {
	it('passes when HMAC and timingSafeEqual only appear in the sanctioned modules', async () => {
		const result = await gate({});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('ok:');
	});

	it('fails on a new open-coded HMAC, reporting the import and the sign', async () => {
		const result = await gate({ 'apps/api/convex/mail/newRoute.ts': OPEN_CODED_HMAC });
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('apps/api/convex/mail/newRoute.ts:2:importKey(HMAC)');
		expect(result.stdout).toContain('apps/api/convex/mail/newRoute.ts:9:sign(HMAC)');
	});

	it('fails on a timingSafeEqual call in a Node service or package', async () => {
		const result = await gate({
			'apps/mta/src/auth/apiKey.ts': [
				"import { timingSafeEqual } from 'node:crypto';",
				'export const eq = (a: Buffer, b: Buffer) => timingSafeEqual(a, b);',
				'',
			].join('\n'),
			'packages/mail-auth/src/compare.ts': 'return timingSafeEqual (x, y);\n',
		});
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('apps/mta/src/auth/apiKey.ts:2:timingSafeEqual');
		expect(result.stdout).toContain('packages/mail-auth/src/compare.ts:1:timingSafeEqual');
	});

	it('ignores non-HMAC key imports', async () => {
		const result = await gate({
			'apps/api/convex/lib/box.ts': [
				"await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt']);",
				"await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);",
				"await crypto.subtle.importKey('spki', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);",
				'',
			].join('\n'),
		});
		expect(result.code).toBe(0);
	});

	it('exempts tests, generated code and prose', async () => {
		const result = await gate({
			'apps/api/convex/__tests__/route.test.ts': OPEN_CODED_HMAC,
			'apps/api/convex/mail/route.test.ts': OPEN_CODED_HMAC,
			'apps/api/convex/_generated/server.ts': OPEN_CODED_HMAC,
			'apps/mta/src/doc.ts': [
				'/**',
				" * Never call timingSafeEqual( directly or importKey(… 'HMAC' …) by hand.",
				' */',
				'// timingSafeEqual(a, b) would throw on unequal lengths',
				'export {};',
				'',
			].join('\n'),
		});
		expect(result.code).toBe(0);
	});

	it('--generate lists every hit, sanctioned or not, and exits 0', async () => {
		const result = await gate(
			{ 'apps/web/server/utils/x.ts': 'timingSafeEqual(a, b);\n' },
			{ args: ['--generate'] }
		);
		expect(result.code).toBe(0);
		expect(result.stdout.split('\n').filter(Boolean)).toEqual([
			'apps/api/convex/lib/crypto.ts:1:importKey(HMAC)',
			'apps/api/convex/lib/crypto.ts:2:sign(HMAC)',
			'apps/convex-fn-proxy/src/allowlist.ts:1:timingSafeEqual',
			'apps/web/server/utils/x.ts:1:timingSafeEqual',
			'packages/shared/src/constantTimeEqual.ts:1:timingSafeEqual',
		]);
	});

	it('fails on an HMAC verify', async () => {
		const result = await gate({
			'apps/api/convex/mail/check.ts':
				"const ok = await crypto.subtle.verify('HMAC', key, signature, data);\n",
		});
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('apps/api/convex/mail/check.ts:1:verify(HMAC)');
	});

	it('fails on an HMAC sign or verify that names the algorithm as an object', async () => {
		const result = await gate({
			'apps/api/convex/mail/objectForm.ts': [
				"const sig = await crypto.subtle.sign({ name: 'HMAC' }, key, data);",
				'const ok = await crypto.subtle.verify(',
				'\t{ hash: "SHA-256", name: "HMAC" },',
				'\tkey,',
				'\tsignature,',
				'\tdata',
				');',
				"const rsa = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, s, d);",
				'',
			].join('\n'),
		});
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('apps/api/convex/mail/objectForm.ts:1:sign(HMAC)');
		expect(result.stdout).toContain('apps/api/convex/mail/objectForm.ts:2:verify(HMAC)');
		expect(result.stdout).not.toContain('objectForm.ts:8:');
	});

	it('fails on an aliased or destructured timingSafeEqual import', async () => {
		const result = await gate({
			'apps/mta/src/auth/alias.ts': [
				"import { timingSafeEqual as safeEqual } from 'node:crypto';",
				'export const eq = (a: Buffer, b: Buffer) => safeEqual(a, b);',
				'',
			].join('\n'),
			'apps/imap/src/auth/destructure.cjs': [
				"const { timingSafeEqual: eq } = require('node:crypto');",
				'module.exports = (a, b) => eq(a, b);',
				'',
			].join('\n'),
		});
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('apps/mta/src/auth/alias.ts:1:timingSafeEqual');
		expect(result.stdout).toContain('apps/imap/src/auth/destructure.cjs:1:timingSafeEqual');
	});

	it('fails on an importKey whose algorithm is not a literal', async () => {
		const result = await gate({
			'apps/api/convex/lib/variable.ts': [
				"const algorithm = { name: 'HMAC', hash: 'SHA-256' };",
				"await crypto.subtle.importKey('raw', bytes, algorithm, false, ['sign']);",
				"await crypto.subtle.importKey('raw', bytes, { name: kind, hash: 'SHA-256' }, false, ['sign']);",
				'',
			].join('\n'),
		});
		expect(result.code).toBe(1);
		expect(result.stdout).toContain(
			'apps/api/convex/lib/variable.ts:2:importKey(variable algorithm)'
		);
		expect(result.stdout).toContain(
			'apps/api/convex/lib/variable.ts:3:importKey(variable algorithm)'
		);
	});

	it('scans .tsx, .cjs and .cts files', async () => {
		const result = await gate({
			'apps/web/app/components/Sig.tsx': OPEN_CODED_HMAC,
			'packages/tools/src/compare.cjs': 'module.exports = (a, b) => timingSafeEqual(a, b);\n',
			'packages/tools/src/compare.cts': 'export const eq = (a, b) => timingSafeEqual(a, b);\n',
		});
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('apps/web/app/components/Sig.tsx:2:importKey(HMAC)');
		expect(result.stdout).toContain('packages/tools/src/compare.cjs:1:timingSafeEqual');
		expect(result.stdout).toContain('packages/tools/src/compare.cts:1:timingSafeEqual');
	});

	it('fails on a hand-written XOR-accumulate compare loop', async () => {
		const result = await gate({
			'apps/api/convex/lib/loop.ts': [
				'let diff = 0;',
				'for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);',
				'let other = 0;',
				'for (let i = 0; i < a.length; i++) other = other | (x[i] ^ y[i]);',
				'let sum = 0;',
				'for (let i = 0; i < a.length; i++) sum += a[i] ^ b[i];',
				'let total = 0;',
				'for (let i = 0; i < a.length; i++) total = total + (a[i] ^ b[i]);',
				'',
			].join('\n'),
		});
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('apps/api/convex/lib/loop.ts:2:xor-compare');
		expect(result.stdout).toContain('apps/api/convex/lib/loop.ts:4:xor-compare');
		expect(result.stdout).toContain('apps/api/convex/lib/loop.ts:6:xor-compare');
		expect(result.stdout).toContain('apps/api/convex/lib/loop.ts:8:xor-compare');
	});

	it('does not read an XOR outside an accumulating OR as a compare loop', async () => {
		const result = await gate({
			'apps/api/convex/lib/bits.ts': [
				'const mixed = a ^ b;',
				'flags |= MASK;',
				'count += step;',
				'hash = (hash ^ byte) >>> 0;',
				'',
			].join('\n'),
		});
		expect(result.code).toBe(0);
	});

	it('fails when an allowed module no longer exists', async () => {
		const result = await gate({}, { omit: ['apps/convex-fn-proxy/src/allowlist.ts'] });
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('no longer exist');
		expect(result.stdout).toContain('apps/convex-fn-proxy/src/allowlist.ts');
	});
});
