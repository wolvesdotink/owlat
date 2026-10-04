import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readZipEntries, type ZipEntry } from './zipArchive';

/**
 * Find secret values in a Playwright report before CI uploads it.
 *
 * The E2E workflow uploads `playwright-report/` as an artifact of a public
 * repository, and anyone signed in to GitHub can download it. Log masking does
 * not apply to artifact contents. A secret that reaches a trace (Playwright
 * records the headers of its own HTTP requests) or an attachment would be
 * published with the report.
 *
 * Secrets can sit in three places in an HTML report: plain files (attachments
 * such as `browser-console.txt`), trace archives (`data/*.zip`), and the report
 * data that `index.html` embeds as a base64 zip. All three are searched, and so
 * are file and archive member names. Each secret is matched whole, in the forms
 * a report can carry it in: raw, JSON-escaped, `\u`-escaped, URL-encoded and
 * base64 (see {@link secretForms}).
 *
 * The scan fails closed. Anything it cannot read counts as a finding: an archive
 * it cannot open, a `.zip` without the zip signature, a symlink or other
 * non-regular file, a file or directory that errors on read. Such a report is
 * one nobody has checked.
 *
 * Some credentials cannot be known in advance: the session cookie and the
 * Convex JWT are minted during the run. {@link scanReport} can also refuse what
 * carries them: any value shaped like a JWT, and any Playwright trace archive
 * (a trace records request headers and response bodies, so it holds the
 * session cookie, the JWT and the deployment URLs at once). The cookie values
 * themselves come from the saved storage state ({@link storageStateSecrets}).
 *
 * Findings carry the path and the secret's label, never its value. A path can
 * hold an encoded secret too, so callers must not print it either
 * ({@link findingId}).
 */

export interface SecretFinding {
	/** Path relative to the scanned directory, with `!entry` for a zip member. */
	file: string;
	/** The secret's label (its environment variable name), or `unreadable`. */
	label: string;
}

export interface NamedSecret {
	label: string;
	value: string;
}

/** What {@link scanReport} refuses, besides the archives it cannot read. */
export interface ReportRules {
	/** Known values, matched in every encoding {@link secretForms} lists. */
	secrets: NamedSecret[];
	/** Refuse anything shaped like a JWT, whatever its value. */
	jwts?: boolean;
	/** Refuse Playwright trace archives and the trace viewer that serves them. */
	traces?: boolean;
}

export const JWT_LABEL = 'JWT-shaped token';
export const TRACE_LABEL = 'trace archive';

/**
 * A signed JWT: header and payload are base64url JSON objects, so both start
 * `eyJ` (`{"`). The minimum lengths keep short look-alikes out; a real header
 * and payload are far longer.
 */
export const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

/**
 * Member names only a Playwright trace has: the action log, the network log
 * and the call stacks (`test.trace`, `0-trace.network`, `0-trace.stacks`).
 */
const TRACE_MEMBER = /\.(trace|network|stacks)$/;

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const MAX_ZIP_DEPTH = 3;
const EMBEDDED_ZIP = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/g;

/** Shortest base64 core worth matching; shorter would match by chance. */
const MIN_FORM_LENGTH = 8;

/** The base64 characters fully determined by `value` when it starts `offset` bytes into a stream. */
function base64Core(value: Buffer, offset: number, alphabet: 'base64' | 'base64url'): string {
	const encoded = Buffer.concat([Buffer.alloc(offset), value]).toString(alphabet);
	const first = Math.ceil((offset * 8) / 6);
	const last = Math.floor(((offset + value.length) * 8) / 6);
	return encoded.slice(first, last);
}

/**
 * Every form of `value` the scan matches, each a whole encoding of the secret:
 *
 * - raw;
 * - JSON-escaped, with and without `\/` for a slash, and fully `\u`-escaped
 *   in lower- and uppercase hex;
 * - URL-encoded (`encodeURIComponent`), in upper- and lowercase hex;
 * - base64 and base64url, at each of the three byte alignments a value can
 *   have inside a longer encoded stream (the characters that depend only on
 *   the secret's own bytes).
 *
 * A fragment of a secret is never matched: that would flag unrelated text.
 */
export function secretForms(value: string): Buffer[] {
	const forms = new Set<string>([value]);
	const json = JSON.stringify(value).slice(1, -1);
	forms.add(json);
	forms.add(json.replaceAll('/', '\\/'));
	const units = Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
	const unicode = units.map((unit) => `\\u${unit.toString(16).padStart(4, '0')}`).join('');
	forms.add(unicode);
	forms.add(unicode.replaceAll(/[a-f]/g, (hex) => hex.toUpperCase()));
	const url = encodeURIComponent(value);
	forms.add(url);
	forms.add(url.replaceAll(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()));
	const bytes = Buffer.from(value);
	for (const alphabet of ['base64', 'base64url'] as const) {
		forms.add(bytes.toString(alphabet));
		for (const offset of [0, 1, 2]) {
			// A core drops the edge characters, so on a very short secret it could
			// be short enough to occur by chance.
			const core = base64Core(bytes, offset, alphabet);
			if (core.length >= MIN_FORM_LENGTH) forms.add(core);
		}
	}
	return [...forms].map((form) => Buffer.from(form));
}

/** A stable, printable id for a finding's path that reveals nothing of it. */
export function findingId(file: string): string {
	return createHash('sha256').update(file).digest('hex').slice(0, 12);
}

interface Scan {
	secrets: Array<{ label: string; forms: Buffer[] }>;
	jwts: boolean;
	traces: boolean;
	findings: SecretFinding[];
}

function matchSecrets(data: Buffer, file: string, scan: Scan): void {
	for (const secret of scan.secrets) {
		if (secret.forms.some((form) => data.includes(form))) {
			scan.findings.push({ file, label: secret.label });
		}
	}
	// latin1 maps every byte to one character, so the pattern sees the bytes
	// whatever the file's encoding.
	if (scan.jwts && JWT_PATTERN.test(data.toString('latin1'))) {
		scan.findings.push({ file, label: JWT_LABEL });
	}
}

function scanBuffer(data: Buffer, file: string, name: string, scan: Scan, depth: number): void {
	matchSecrets(Buffer.from(name), file, scan);
	// For an archive this is the raw bytes, which covers stored members and
	// names even if reading the archive fails; deflated members are read below.
	matchSecrets(data, file, scan);

	const zips: Array<{ file: string; data: Buffer }> = [];
	const looksLikeZip = data.subarray(0, 4).equals(ZIP_MAGIC);
	if (looksLikeZip) zips.push({ file, data });
	else if (name.toLowerCase().endsWith('.zip')) scan.findings.push({ file, label: 'unreadable' });
	if (name.toLowerCase().endsWith('.html')) {
		let index = 0;
		for (const match of data.toString('latin1').matchAll(EMBEDDED_ZIP)) {
			zips.push({ file: `${file}#embedded-${index++}`, data: Buffer.from(match[1]!, 'base64') });
		}
	}

	for (const zip of zips) {
		if (depth >= MAX_ZIP_DEPTH) {
			scan.findings.push({ file: zip.file, label: 'unreadable' });
			continue;
		}
		let entries: ZipEntry[];
		try {
			entries = readZipEntries(zip.data);
		} catch {
			scan.findings.push({ file: zip.file, label: 'unreadable' });
			continue;
		}
		if (scan.traces && entries.some((entry) => TRACE_MEMBER.test(entry.name))) {
			scan.findings.push({ file: zip.file, label: TRACE_LABEL });
		}
		for (const entry of entries) {
			scanBuffer(entry.data, `${zip.file}!${entry.name}`, entry.name, scan, depth + 1);
		}
	}
}

/** Walk `dir` without following links; anything that is not a readable regular file is a finding. */
function scanDirectory(root: string, dir: string, scan: Scan): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		scan.findings.push({ file: relative(root, dir) || '.', label: 'unreadable' });
		return;
	}
	for (const name of names) {
		const path = join(dir, name);
		const file = relative(root, path);
		try {
			const stat = lstatSync(path);
			if (stat.isDirectory()) {
				matchSecrets(Buffer.from(name), file, scan);
				// The HTML reporter copies the viewer in only when the report has a
				// trace, so its presence alone means one got in.
				if (scan.traces && dir === root && name === 'trace') {
					scan.findings.push({ file, label: TRACE_LABEL });
				}
				scanDirectory(root, path, scan);
			} else if (stat.isFile()) {
				scanBuffer(readFileSync(path), file, name, scan, 0);
			} else {
				matchSecrets(Buffer.from(name), file, scan);
				scan.findings.push({ file, label: 'unreadable' });
			}
		} catch {
			scan.findings.push({ file, label: 'unreadable' });
		}
	}
}

/**
 * Every place under `dir` that breaks one of `rules`, or that could not be
 * read. Empty secrets are ignored. An empty result means the directory is safe
 * to publish as far as these rules go.
 */
export function scanReport(dir: string, rules: ReportRules): SecretFinding[] {
	const present = rules.secrets.filter((secret) => secret.value.length > 0);
	const scan: Scan = {
		secrets: present.map((secret) => ({ label: secret.label, forms: secretForms(secret.value) })),
		jwts: rules.jwts ?? false,
		traces: rules.traces ?? false,
		findings: [],
	};
	if (scan.secrets.length === 0 && !scan.jwts && !scan.traces) return [];
	scanDirectory(dir, dir, scan);
	return scan.findings;
}

/** {@link scanReport} for known values only. */
export function findSecretsInReport(dir: string, secrets: NamedSecret[]): SecretFinding[] {
	return scanReport(dir, { secrets });
}
