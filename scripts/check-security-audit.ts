import { readFileSync } from 'node:fs';

const SIMPLE_GIT_VIA_NUXT_DEVTOOLS =
	"it only arrives through @nuxt/devtools@3.4.1, whose latest stable release still requires simple-git ^3.36.0. The fixed simple-git 4.x has no default export, and devtools does `import Git from 'simple-git'`, so an override stops the devtools module (which nuxt adds to the apps/web, apps/marketing and apps/docs builds) from loading. Devtools only runs git branch, git rev-parse --short HEAD and git status, with fixed arguments and no extra environment, against the Nuxt root to name a dev-server analyze build. No request input reaches git, and no Nitro output or other workspace ships simple-git. Drop this once a stable @nuxt/devtools no longer depends on simple-git 3.";

export const ACKNOWLEDGED_ADVISORIES: Readonly<Record<string, string>> = Object.freeze({
	'GHSA-W3RX-R6R6-PGPR':
		'image-size@2.0.2 has no upstream release; patches/image-size@2.0.2.patch rejects zero, truncated, and non-advancing ICNS entries.',
	'GHSA-5P2G-FCMC-QVQQ':
		'image-size@2.0.2 has no upstream release; patches/image-size@2.0.2.patch rejects undersized and non-advancing HEIF/JXL boxes.',
	'GHSA-86W9-CPQP-85RV':
		'node-forge@1.4.0 has no upstream fix; it only reaches the dev server through listhen, which generates a self-signed certificate and never verifies an RSA signature. Drop this once node-forge ships a fix.',
	'GHSA-VFJ7-8CJW-P6XM':
		'braces@3.0.3 has no upstream fix; it only arrives through micromatch@4.0.8 at build time (nitropack via globby/fast-glob, @intlify/unplugin-vue-i18n via fast-glob, and the @nuxt/content module in apps/docs), which expand glob patterns from repository config, never request input. The apps/web Nitro output does not ship braces or micromatch, apps/docs and apps/marketing deploy as static files behind nginx, and no other workspace depends on it. Drop this once braces ships a fix.',
	'GHSA-X6JW-M9V5-85VH': `simple-git@3.36.0 has no fixed 3.x release; ${SIMPLE_GIT_VIA_NUXT_DEVTOOLS}`,
	'GHSA-G4WM-2VF7-VFGR': `simple-git@3.36.0 has no fixed 3.x release; ${SIMPLE_GIT_VIA_NUXT_DEVTOOLS}`,
	'GHSA-858H-WHJF-MVG5': `simple-git@3.36.0 has no fixed 3.x release; ${SIMPLE_GIT_VIA_NUXT_DEVTOOLS}`,
	'GHSA-V5RQ-49VH-5V5C': `@simple-git/argv-parser@1.1.1 has no fixed 1.x release (simple-git 3 requires ^1.1.0, and 2.0.1 ships only with simple-git 4); ${SIMPLE_GIT_VIA_NUXT_DEVTOOLS}`,
});

export interface AuditFinding {
	pkg: string;
	severity: 'high' | 'critical';
	title: string;
	url: string;
	ghsa: string | null;
}

export interface AuditClassification {
	acknowledged: AuditFinding[];
	blocking: AuditFinding[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ghsaFromUrl(url: string): string | null {
	try {
		const segments = new URL(url).pathname.split('/').filter(Boolean);
		const candidate = segments.at(-1)?.toUpperCase();
		return candidate?.startsWith('GHSA-') ? candidate : null;
	} catch {
		return null;
	}
}

export function classifyAuditJson(
	raw: string,
	acknowledgements: Readonly<Record<string, string>> = ACKNOWLEDGED_ADVISORIES
): AuditClassification {
	if (!raw.trim()) throw new Error('bun audit produced no output — failing closed.');

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`bun audit produced malformed JSON — failing closed: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (!isRecord(parsed)) {
		throw new Error('bun audit JSON must be an object keyed by package — failing closed.');
	}

	const classification: AuditClassification = { acknowledged: [], blocking: [] };
	for (const [pkg, advisories] of Object.entries(parsed)) {
		if (!Array.isArray(advisories)) {
			throw new Error(`bun audit entry for ${pkg} must be an array — failing closed.`);
		}
		for (const advisory of advisories) {
			if (
				!isRecord(advisory) ||
				typeof advisory['severity'] !== 'string' ||
				typeof advisory['title'] !== 'string' ||
				typeof advisory['url'] !== 'string'
			) {
				throw new Error(`bun audit advisory for ${pkg} is malformed — failing closed.`);
			}
			const severity = advisory['severity'].toLowerCase();
			if (severity !== 'high' && severity !== 'critical') continue;

			const ghsa = ghsaFromUrl(advisory['url']);
			const finding: AuditFinding = {
				pkg,
				severity,
				title: advisory['title'],
				url: advisory['url'],
				ghsa,
			};
			if (ghsa && acknowledgements[ghsa]) classification.acknowledged.push(finding);
			else classification.blocking.push(finding);
		}
	}
	return classification;
}

export function formatAuditClassification(
	classification: AuditClassification,
	acknowledgements: Readonly<Record<string, string>> = ACKNOWLEDGED_ADVISORIES
): { stdout: string[]; stderr: string[]; exitCode: 0 | 1 } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	if (classification.acknowledged.length) {
		stdout.push('Acknowledged (locally mitigated / no upstream fix / not exploitable here):');
		for (const finding of classification.acknowledged) {
			stdout.push(
				` - [${finding.severity}] ${finding.pkg} ${finding.ghsa}: ${acknowledgements[finding.ghsa!]}`
			);
		}
	}
	if (classification.blocking.length === 0) {
		stdout.push('No blocking high/critical vulnerabilities.');
		return { stdout, stderr, exitCode: 0 };
	}

	stderr.push('Blocking vulnerabilities found:');
	for (const finding of classification.blocking) {
		stderr.push(
			` - [${finding.severity}] ${finding.pkg} ${finding.ghsa ?? 'unknown-advisory'}: ${finding.title} (${finding.url})`
		);
	}
	return { stdout, stderr, exitCode: 1 };
}

if (import.meta.main) {
	try {
		const auditPath = Bun.argv[2] ?? 'audit.json';
		const result = formatAuditClassification(classifyAuditJson(readFileSync(auditPath, 'utf8')));
		for (const line of result.stdout) console.log(line);
		for (const line of result.stderr) console.error(line);
		process.exit(result.exitCode);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
