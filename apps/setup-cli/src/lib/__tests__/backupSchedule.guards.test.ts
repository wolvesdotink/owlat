import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// scripts/owlat is pure bash and isn't exercised by any runtime test, so these
// static guards lock the `backup-schedule` subcommand (audit item
// backups-setup-step) against regression: the self-host CLI must expose a way to
// SCHEDULE backups (not just the on-demand `owlat backup`), generate a unit/cron
// that runs scripts/backup.sh daily, and stay idempotent + OS-aware.

const here = dirname(fileURLToPath(import.meta.url));
// apps/setup-cli/src/lib/__tests__ → repo root is five levels up.
const repoRoot = resolve(here, '../../../../..');
const owlatCli = readFileSync(resolve(repoRoot, 'scripts/owlat'), 'utf8');

describe('scripts/owlat — backup-schedule subcommand', () => {
	it('dispatches a backup-schedule subcommand and an enable-backups alias', () => {
		expect(owlatCli).toMatch(/^\s*backup-schedule\)/m);
		expect(owlatCli).toMatch(/^\s*enable-backups\)/m);
		// the alias is a direct shortcut for the enable action.
		expect(owlatCli).toMatch(/enable-backups\)\s*\n\s*backup_schedule enable/);
	});

	it('documents the subcommand in --help so it is discoverable', () => {
		expect(owlatCli).toMatch(/owlat backup-schedule \[enable\|disable\|status\]/);
		// the help printer must reach the line (the comment block runs past it,
		// through the `owlat --help` entry on line 29).
		expect(owlatCli).toMatch(/sed -n '4,29p'/);
	});

	it('handles enable / disable / status actions', () => {
		expect(owlatCli).toMatch(/enable\)\s+backup_schedule_enable/);
		expect(owlatCli).toMatch(/disable\)\s+backup_schedule_disable/);
		expect(owlatCli).toMatch(/status\)\s+backup_schedule_status/);
		// status is the safe default when no action is given.
		expect(owlatCli).toMatch(/action="\$\{1:-status\}"/);
	});

	it('schedules a DAILY systemd timer that runs scripts/backup.sh', () => {
		expect(owlatCli).toMatch(/BACKUP_SCHEDULE_ONCALENDAR="\*-\*-\* 04:00:00"/);
		expect(owlatCli).toMatch(/OnCalendar=\$\{BACKUP_SCHEDULE_ONCALENDAR\}/);
		expect(owlatCli).toMatch(/ExecStart=\/usr\/bin\/env bash \$\{OWLAT_DIR\}\/scripts\/backup\.sh/);
		expect(owlatCli).toMatch(/WantedBy=timers\.target/);
		expect(owlatCli).toMatch(/systemctl enable --now "\$\{BACKUP_UNIT_NAME\}\.timer"/);
	});

	it('falls back to a DAILY /etc/cron.d entry that runs scripts/backup.sh', () => {
		expect(owlatCli).toMatch(/BACKUP_SCHEDULE_CRON="0 4 \* \* \*"/);
		expect(owlatCli).toMatch(/\$\{BACKUP_SCHEDULE_CRON\} root cd \$\{OWLAT_DIR\} && bash scripts\/backup\.sh/);
	});

	it('is OS-aware — systemd first, cron fallback, else a clear no-op message', () => {
		const fnStart = owlatCli.indexOf('backup_schedule_enable()');
		const fnEnd = owlatCli.indexOf('\n}', fnStart);
		const enableFn = owlatCli.slice(fnStart, fnEnd);
		// the order matters: prefer systemctl, then /etc/cron.d, then warn + return 1.
		expect(enableFn).toMatch(/command -v systemctl[\s\S]*-d \/etc\/cron\.d[\s\S]*Neither systemd nor/);
		expect(enableFn).toMatch(/return 1/);
	});

	it('enable is idempotent — it overwrites the unit/cron files in place', () => {
		// `tee` truncates+rewrites, so re-running enable converges rather than
		// appending a second job.
		expect(owlatCli).toMatch(/backup_systemd_timer_unit\s+\|\s+_root tee "\$BACKUP_TIMER_FILE"/);
		expect(owlatCli).toMatch(/backup_cron_line\s+\|\s+_root tee "\$BACKUP_CRON_FILE"/);
	});

	it('disable is idempotent — only removes installed jobs, else reports nothing to do', () => {
		const fnStart = owlatCli.indexOf('backup_schedule_disable()');
		const fnEnd = owlatCli.indexOf('\nbackup_schedule_status', fnStart);
		const disableFn = owlatCli.slice(fnStart, fnEnd);
		// guard the removals behind existence checks so a second disable is a no-op.
		expect(disableFn).toMatch(/\[\[ -f "\$BACKUP_TIMER_FILE" \|\| -f "\$BACKUP_SERVICE_FILE" \]\]/);
		expect(disableFn).toMatch(/\[\[ -f "\$BACKUP_CRON_FILE" \]\]/);
		expect(disableFn).toMatch(/nothing to disable/);
	});

	it('writes privileged files through a root helper (sudo when not already root)', () => {
		expect(owlatCli).toMatch(/_root\(\)/);
		expect(owlatCli).toMatch(/id -u.*-eq 0/);
		expect(owlatCli).toMatch(/command -v sudo/);
	});
});
