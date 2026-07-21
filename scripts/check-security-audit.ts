import { readFileSync } from 'node:fs';

export const ACKNOWLEDGED_ADVISORIES: Readonly<Record<string, string>> = Object.freeze({
	// Nuxt <4.4.7: routeRules middleware bypass via case-sensitivity. Owlat
	// defines no routeRules (web has an empty object; docs/marketing have none),
	// so there is no rule to bypass. The fix currently regresses og-image
	// prerendering; revisit when that integration supports Nuxt 4.4.7+.
	'GHSA-MM7M-92G8-7M47':
		'nuxt routeRules bypass: Owlat defines no routeRules; 4.4.7+ currently regresses og-image builds',
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
		stdout.push('Acknowledged (no upstream fix / not exploitable here):');
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
