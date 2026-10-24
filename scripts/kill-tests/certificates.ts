/**
 * The throwaway TLS material the kill tests' IMAP fixture serves.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Create `dir` holding a CA and an `imap.owlat.test` certificate it signs,
 * valid for a day. The mail-sync worker verifies its IMAP peer exactly as in
 * production and is only told to trust this CA, so no TLS check is relaxed for
 * the test.
 *
 * `dir` is bind-mounted into dovecot (master runs as root) and into the worker
 * (runs as `node`, uid 1000). The host user that ran the orchestrator owns
 * it, and on a CI runner that is a different uid, so the directory and the
 * files the containers read must be readable by any uid. Only the CA's key,
 * which no container reads, stays private.
 */
export function makeImapCertificates(dir: string): void {
	mkdirSync(dir, { recursive: true });
	const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
	const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
	openssl(
		'req',
		'-x509',
		...ec,
		'-keyout',
		'ca.key',
		'-out',
		'ca.crt',
		'-days',
		'1',
		'-subj',
		'/CN=owlat-kill-tests-ca'
	);
	openssl('req', ...ec, '-keyout', 'imap.key', '-out', 'imap.csr', '-subj', '/CN=imap.owlat.test');
	writeFileSync(
		join(dir, 'imap.ext'),
		'subjectAltName=DNS:imap.owlat.test\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n'
	);
	openssl(
		'x509',
		'-req',
		'-in',
		'imap.csr',
		'-CA',
		'ca.crt',
		'-CAkey',
		'ca.key',
		'-CAcreateserial',
		'-out',
		'imap.crt',
		'-days',
		'1',
		'-extfile',
		'imap.ext'
	);
	// Explicit modes: the umask must not decide what a container can read.
	chmodSync(dir, 0o755);
	for (const file of ['ca.crt', 'imap.crt', 'imap.key']) chmodSync(join(dir, file), 0o644);
	chmodSync(join(dir, 'ca.key'), 0o600);
}
