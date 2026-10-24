/**
 * The typed report behind `owlat-setup doctor`.
 *
 * Every check doctor runs is recorded here once, as a {@link DoctorCheck} with a
 * stable id, and both outputs are rendered FROM that record: the human checklist
 * (streamed line by line, so a slow MTA probe still shows progress) and the
 * `--json` document. Neither output builds its own list, so a check cannot
 * appear in one and not the other, or pass in one and fail in the other.
 *
 * What a message may contain is decided by `doctorText.ts`: messages are built
 * from code-owned and untrusted parts, configured values only go through its
 * sanitizers, and the known-secret pass runs over the untrusted parts once, at
 * record time, before either renderer sees them. Ids, subjects and the other
 * structured fields are identifiers and never pass through it.
 *
 * The JSON shape is a contract for scripts (deployment verification, support
 * bundles). Ids, components and remediation codes are stable; renaming one is a
 * breaking change and needs a `schemaVersion` bump. Adding a check, an id or a
 * field is additive.
 */

import pc from 'picocolors';
import type { EnvMap } from './env';
import { createDoctorRedactor, type DoctorRedactor, type DoctorText } from './doctorText';

/** Bumped only for a breaking change to the JSON shape or to an existing id. */
export const DOCTOR_REPORT_SCHEMA_VERSION = 1;

/** Every check id doctor can emit, in the order the checks run. */
export const DOCTOR_CHECK_IDS = [
	'env.file',
	'flags.state',
	'env.required',
	'send_path.provider',
	'send_path.credential',
	'mta.health',
	'mta.queue_store',
	'mta.worker',
	'mta.dns',
	'mta.circuit_breaker',
	'mta.identity',
	'mta.queue_leak',
	'mta.sending_ips',
	'mta.tcp25',
	'mta.ip_audit',
	'compose.override',
	'compose.services',
	'compose.cli',
	'containers.health',
	'version.drift',
] as const;

export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

/** The part of the install a check observes. */
export type DoctorComponent = 'config' | 'send_path' | 'mta' | 'compose' | 'containers' | 'version';

/**
 * What a failure of the check means. Every check doctor runs today fails the
 * exit code, so this is always `error`; a non-blocking check would be added as
 * a new value.
 */
export type DoctorSeverity = 'error';

/** A stable, machine-readable pointer to the fix for a failed check. */
export type DoctorRemediation =
	| 'run_setup'
	| 'set_env_var'
	| 'configure_email_provider'
	| 'check_mta'
	| 'check_ip_reputation'
	| 'fix_reverse_dns'
	| 'report_queue_leak'
	| 'configure_sending_ips'
	| 'unblock_outbound_smtp'
	| 'replace_or_delist_ip'
	| 'start_stack'
	| 'install_docker_compose'
	| 'inspect_container'
	| 'recreate_containers';

const CHECK_META: Record<
	DoctorCheckId,
	{ component: DoctorComponent; remediation: DoctorRemediation }
> = {
	'env.file': { component: 'config', remediation: 'run_setup' },
	'flags.state': { component: 'config', remediation: 'run_setup' },
	'env.required': { component: 'config', remediation: 'set_env_var' },
	'send_path.provider': { component: 'send_path', remediation: 'configure_email_provider' },
	'send_path.credential': { component: 'send_path', remediation: 'set_env_var' },
	'mta.health': { component: 'mta', remediation: 'check_mta' },
	'mta.queue_store': { component: 'mta', remediation: 'check_mta' },
	'mta.worker': { component: 'mta', remediation: 'check_mta' },
	'mta.dns': { component: 'mta', remediation: 'check_mta' },
	'mta.circuit_breaker': { component: 'mta', remediation: 'check_ip_reputation' },
	'mta.identity': { component: 'mta', remediation: 'fix_reverse_dns' },
	'mta.queue_leak': { component: 'mta', remediation: 'report_queue_leak' },
	'mta.sending_ips': { component: 'mta', remediation: 'configure_sending_ips' },
	'mta.tcp25': { component: 'mta', remediation: 'unblock_outbound_smtp' },
	'mta.ip_audit': { component: 'mta', remediation: 'replace_or_delist_ip' },
	'compose.override': { component: 'compose', remediation: 'run_setup' },
	'compose.services': { component: 'compose', remediation: 'start_stack' },
	'compose.cli': { component: 'compose', remediation: 'install_docker_compose' },
	'containers.health': { component: 'containers', remediation: 'inspect_container' },
	'version.drift': { component: 'version', remediation: 'recreate_containers' },
};

/** The checklist prefix each component has always printed with. */
const TEXT_PREFIX: Record<DoctorComponent, string> = {
	config: '',
	send_path: 'SEND PATH: ',
	mta: 'SEND PATH: ',
	compose: '',
	containers: 'CONTAINERS: ',
	version: 'VERSION: ',
};

/** One evaluated check, before it is recorded. Evaluators return these. */
export interface DoctorFinding {
	check: DoctorCheckId;
	ok: boolean;
	message: DoctorText;
	/**
	 * What the check is about when it runs once per item: an env key name, an IP,
	 * a compose service. An identifier, printed as is.
	 */
	subject?: string;
}

export interface DoctorCheck {
	id: DoctorCheckId;
	subject?: string;
	component: DoctorComponent;
	status: 'pass' | 'fail';
	severity: DoctorSeverity;
	/** Sanitized and redacted, uncoloured, without the text-mode component prefix. */
	message: string;
	/** Present on failed checks only. */
	remediation?: DoctorRemediation;
}

export interface DoctorReport {
	schemaVersion: typeof DOCTOR_REPORT_SCHEMA_VERSION;
	command: 'doctor';
	generatedAt: string;
	ok: boolean;
	summary: { total: number; passed: number; failed: number };
	activeFeatures: string[];
	checks: DoctorCheck[];
}

/** Collects checks in run order and notifies a listener as each one lands. */
export class DoctorReportBuilder {
	readonly checks: DoctorCheck[] = [];
	private redact: DoctorRedactor = (message) => String(message);
	private codeOwnedOnly = false;

	constructor(private readonly onCheck?: (check: DoctorCheck) => void) {}

	/** Redact every later message against this env (call once `.env` is read). */
	useEnv(env: EnvMap): void {
		this.redact = createDoctorRedactor(env);
	}

	/**
	 * Record only the code-owned text of every later message, with each run of
	 * runtime text (MTA answers, docker status lines, error messages) withheld.
	 */
	withholdRuntimeText(): void {
		this.codeOwnedOnly = true;
	}

	record(finding: DoctorFinding): void {
		const meta = CHECK_META[finding.check];
		const check: DoctorCheck = {
			id: finding.check,
			...(finding.subject !== undefined ? { subject: finding.subject } : {}),
			component: meta.component,
			status: finding.ok ? 'pass' : 'fail',
			severity: 'error',
			message: this.codeOwnedOnly ? finding.message.codeOwned() : this.redact(finding.message),
			...(finding.ok ? {} : { remediation: meta.remediation }),
		};
		this.checks.push(check);
		this.onCheck?.(check);
	}

	build(activeFeatures: string[], generatedAt: Date): DoctorReport {
		const failed = this.checks.filter((check) => check.status === 'fail').length;
		return {
			schemaVersion: DOCTOR_REPORT_SCHEMA_VERSION,
			command: 'doctor',
			generatedAt: generatedAt.toISOString(),
			ok: failed === 0,
			summary: { total: this.checks.length, passed: this.checks.length - failed, failed },
			activeFeatures,
			checks: [...this.checks],
		};
	}
}

/** One checklist line, exactly as doctor has always printed it. */
export function renderDoctorCheckLine(check: DoctorCheck): string {
	const mark = check.status === 'pass' ? pc.green('✓') : pc.red('✗');
	return `${mark} ${TEXT_PREFIX[check.component]}${check.message}`;
}

/** The closing line of the checklist. */
export function renderDoctorSummary(report: DoctorReport): string {
	return report.ok
		? pc.green(`All checks passed. Active features: ${report.activeFeatures.join(', ')}`)
		: pc.red(`${report.summary.failed} check(s) failed. Run \`owlat-setup config\` to fix.`);
}
