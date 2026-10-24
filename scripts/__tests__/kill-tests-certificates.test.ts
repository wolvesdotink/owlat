import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeImapCertificates } from '../kill-tests/certificates';

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

function expectReadableByAnyUid(dir: string): void {
	expect(mode(dir)).toBe(0o755);
	for (const file of ['ca.crt', 'imap.crt', 'imap.key']) {
		expect(mode(join(dir, file)), file).toBe(0o644);
	}
	expect(mode(join(dir, 'ca.key'))).toBe(0o600);
}

describe('makeImapCertificates', () => {
	// The containers read the mount as uid 1000 (node) whatever uid created it
	// on the host; a CI runner's uid differs, a developer's often does not.
	it('opens up a private directory such as a fresh mkdtemp one', () => {
		const dir = mkdtempSync(join(tmpdir(), 'owlat-kill-certs-test-'));
		scratch.push(dir);
		expect(mode(dir)).toBe(0o700);

		makeImapCertificates(dir);

		expectReadableByAnyUid(dir);
	});

	it('creates a missing directory the same way', () => {
		const parent = mkdtempSync(join(tmpdir(), 'owlat-kill-certs-test-'));
		scratch.push(parent);
		const dir = join(parent, 'certs');

		makeImapCertificates(dir);

		expectReadableByAnyUid(dir);
	});
});
