/**
 * Guard: owlat's PGP / S-MIME support is DETECTION + honest disclosure only —
 * it does not verify signatures or decrypt bodies (see secureMessage.ts and
 * PostboxSecurityBadge.vue, which state "Signed — not verified" / "can't
 * decrypt"). Pulling in an OpenPGP / PKCS#7 crypto library is therefore a
 * contract change: the badge copy and the reader's "hide the body, offer
 * recovery" behavior would all be misleading once decryption is actually
 * possible.
 *
 * This test fails the moment any workspace package declares a crypto dependency
 * (openpgp / node-forge / kbpgp) WITHOUT also shipping a verify/decrypt module —
 * forcing whoever adds the dep to also flip the detection-only disclosures.
 *
 * RFC 3156 (PGP/MIME), RFC 4880 (OpenPGP), RFC 8551 (S/MIME).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Crypto libraries that would imply real signature verification / decryption. */
const E2E_CRYPTO_PACKAGES = ['openpgp', 'node-forge', 'kbpgp'];

/** Substrings that mark a real verify/decrypt implementation (not detection). */
const DECRYPT_MODULE_MARKERS = [
	'decryptMessage',
	'verifySignature',
	'decryptBody',
	'openpgpDecrypt',
];

/** Collect every workspace package.json under apps/ and packages/. */
function workspacePackageJsons(): string[] {
	const out: string[] = [];
	for (const group of ['apps', 'packages']) {
		const groupDir = join(REPO_ROOT, group);
		if (!existsSync(groupDir)) continue;
		for (const entry of readdirSync(groupDir)) {
			const pkg = join(groupDir, entry, 'package.json');
			if (existsSync(pkg) && statSync(pkg).isFile()) out.push(pkg);
		}
	}
	return out;
}

/** Whether a package declares any of the crypto libraries in any dep field. */
function declaresCryptoDep(pkgJson: Record<string, unknown>): string[] {
	const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
	const found = new Set<string>();
	for (const field of fields) {
		const deps = pkgJson[field];
		if (deps && typeof deps === 'object') {
			for (const name of Object.keys(deps as Record<string, unknown>)) {
				if (E2E_CRYPTO_PACKAGES.includes(name)) found.add(name);
			}
		}
	}
	return [...found];
}

/** Whether the repo ships a real verify/decrypt module (marker in any source). */
function hasDecryptModule(): boolean {
	const stack = [join(REPO_ROOT, 'apps'), join(REPO_ROOT, 'packages')];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (name === 'node_modules' || name === 'dist' || name === '.nuxt') continue;
			const full = join(dir, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				stack.push(full);
			} else if (/\.(ts|js|vue|mjs)$/.test(name)) {
				const src = readFileSync(full, 'utf8');
				if (DECRYPT_MODULE_MARKERS.some((m) => src.includes(m))) return true;
			}
		}
	}
	return false;
}

describe('E2E crypto dependency guard (detection-only contract)', () => {
	it('lists at least one workspace package (sanity)', () => {
		expect(workspacePackageJsons().length).toBeGreaterThan(0);
	});

	it('no package declares an OpenPGP / S-MIME crypto dep without a verify/decrypt module', () => {
		const offenders: Array<{ pkg: string; deps: string[] }> = [];
		for (const pkgPath of workspacePackageJsons()) {
			const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
			const deps = declaresCryptoDep(pkgJson);
			if (deps.length > 0) offenders.push({ pkg: pkgPath, deps });
		}

		if (offenders.length === 0) {
			// The detection-only contract still holds: no crypto deps at all.
			expect(offenders).toEqual([]);
			return;
		}

		// A crypto dep appeared — it is only allowed alongside a real decrypt/verify
		// module (which must also have flipped the "not verified" / "can't decrypt"
		// disclosures). If the module is missing, name the offending packages.
		const detail = offenders
			.map((o) => `${o.pkg} -> ${o.deps.join(', ')}`)
			.join('\n');
		expect(
			hasDecryptModule(),
			`Crypto dependency declared without a verify/decrypt module ` +
				`(${DECRYPT_MODULE_MARKERS.join(' / ')}). ` +
				`Either remove the dep or implement real decryption AND update the ` +
				`detection-only disclosures.\n${detail}`
		).toBe(true);
	});
});
