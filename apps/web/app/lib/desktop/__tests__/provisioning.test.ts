import { describe, it, expect } from 'vitest';
import { SetupStep } from '@owlat/shared/setupProgress';
import {
	createTimeline,
	applyStepEvent,
	setStepState,
	PROVISION_TIMELINE,
	systemCheckCommand,
	installDockerCommand,
	fetchOwlatCommand,
	prepareInstallDirCommand,
	buildSetupImageCommand,
	installerCommand,
	installSource,
	dockerPlatform,
	setupConfigPath,
	deriveNetworkUrls,
	deriveHostnames,
	networkUrlsFromHosts,
	isLoopbackHost,
	isLoopbackUrl,
	canOpenWorkspaceUrl,
	describeHostKey,
	DEFAULT_REMOTE,
	LOCAL_SETUP_IMAGE,
} from '../provisioning';
import {
	assessPassword,
	validateAdminPassword,
	isIpv4,
	isIpv6,
	detectPublicIpCommand,
	parsePublicIp,
	resolveServerIp,
	buildDnsRecords,
	removeSetupConfigCommand,
	stderrTail,
	SERVER_IP_PLACEHOLDER,
	MIN_ADMIN_PASSWORD_LENGTH,
} from '../provisioningForm';

describe('timeline', () => {
	it('starts every step pending and includes all server steps', () => {
		const steps = createTimeline();
		expect(steps).toHaveLength(PROVISION_TIMELINE.length);
		expect(steps.every((s) => s.state === 'pending')).toBe(true);
		for (const id of Object.values(SetupStep)) {
			expect(steps.find((s) => s.id === id)).toBeTruthy();
		}
		// desktop steps + finish are present too
		expect(steps.find((s) => s.id === 'ssh-connect')).toBeTruthy();
		expect(steps.find((s) => s.id === 'finish')).toBeTruthy();
	});

	it('default timeline has no build step', () => {
		expect(createTimeline().find((s) => s.id === 'build-setup-image')).toBeUndefined();
	});

	it('local-build mode retitles the fetch step and inserts the build step before upload-config', () => {
		const steps = createTimeline('local-build');
		expect(steps.find((s) => s.id === 'fetch-owlat')?.title).toBe('Upload Owlat (local source)');
		const build = steps.findIndex((s) => s.id === 'build-setup-image');
		expect(build).toBeGreaterThan(steps.findIndex((s) => s.id === 'fetch-owlat'));
		expect(build).toBe(steps.findIndex((s) => s.id === 'upload-config') - 1);
		expect(steps[build]?.state).toBe('pending');
		expect(steps[build]?.group).toBe('connect');
	});

	it('local-push mode inserts local-build + push steps instead of the server build', () => {
		const steps = createTimeline('local-push');
		const build = steps.findIndex((s) => s.id === 'build-images-local');
		const push = steps.findIndex((s) => s.id === 'push-images');
		expect(build).toBeGreaterThan(-1);
		expect(push).toBe(build + 1);
		expect(push).toBe(steps.findIndex((s) => s.id === 'upload-config') - 1);
		expect(steps.find((s) => s.id === 'build-setup-image')).toBeUndefined();
	});
});

describe('applyStepEvent', () => {
	const ev = (id: string, status: 'running' | 'ok' | 'failed' | 'skipped', extra = {}) =>
		({ v: 1 as const, event: 'step' as const, id, title: id, status, ts: 1, ...extra });

	it('maps each status to the timeline state', () => {
		const steps = createTimeline();
		applyStepEvent(steps, ev(SetupStep.ComposeUp, 'running'));
		expect(steps.find((s) => s.id === SetupStep.ComposeUp)?.state).toBe('running');
		applyStepEvent(steps, ev(SetupStep.ComposeUp, 'ok', { detail: 'up' }));
		const s = steps.find((x) => x.id === SetupStep.ComposeUp);
		expect(s?.state).toBe('ok');
		expect(s?.detail).toBe('up');
	});

	it('maps an ok event flagged warn to the warn state', () => {
		const steps = createTimeline();
		applyStepEvent(steps, ev(SetupStep.WaitRoutes, 'ok', { warn: true }));
		expect(steps.find((s) => s.id === SetupStep.WaitRoutes)?.state).toBe('warn');
	});

	it('maps failed and skipped', () => {
		const steps = createTimeline();
		applyStepEvent(steps, ev(SetupStep.DeployFunctions, 'failed'));
		applyStepEvent(steps, ev(SetupStep.SeedDemo, 'skipped'));
		expect(steps.find((s) => s.id === SetupStep.DeployFunctions)?.state).toBe('failed');
		expect(steps.find((s) => s.id === SetupStep.SeedDemo)?.state).toBe('skipped');
	});

	it('ignores unknown step ids', () => {
		const steps = createTimeline();
		expect(() => applyStepEvent(steps, ev('nope', 'ok'))).not.toThrow();
	});
});

describe('setStepState', () => {
	it('sets state + detail for a desktop step', () => {
		const steps = createTimeline();
		setStepState(steps, 'ssh-connect', 'ok', '1.2.3.4:22');
		const s = steps.find((x) => x.id === 'ssh-connect');
		expect(s?.state).toBe('ok');
		expect(s?.detail).toBe('1.2.3.4:22');
	});
});

describe('remote commands', () => {
	const remote = { ...DEFAULT_REMOTE, installDir: '/opt/owlat', branch: 'main', repo: 'https://github.com/wolvesdotink/owlat.git' };

	it('system check probes docker + compose', () => {
		const cmd = systemCheckCommand();
		expect(cmd).toContain('command -v docker');
		expect(cmd).toContain('docker compose version');
		expect(cmd).toContain('uname -s');
	});

	it('install-docker is idempotent and uses the official script', () => {
		const cmd = installDockerCommand();
		expect(cmd).toContain('get.docker.com');
		expect(cmd).toContain('command -v docker'); // guards against reinstall
	});

	it('fetch clones into the install dir on the requested branch', () => {
		const cmd = fetchOwlatCommand(remote);
		expect(cmd).toContain("git clone --depth 1 --branch 'main'");
		expect(cmd).toContain("'/opt/owlat'");
		expect(cmd).toContain('https://github.com/wolvesdotink/owlat.git');
	});

	it('installer runs quickstart non-interactively with JSON progress + the uploaded config', () => {
		const cmd = installerCommand(remote);
		expect(cmd).toContain('OWLAT_PROGRESS=json');
		expect(cmd).toContain('quickstart');
		expect(cmd).toContain("--config '/opt/owlat/.owlat-setup.json'");
		// Published-artifact install: no local-build overrides.
		expect(cmd).not.toContain('OWLAT_BUILD_LOCAL');
		expect(cmd).not.toContain('OWLAT_SETUP_IMAGE');
	});

	it('prepare-install-dir creates the dir and hands it to the SSH user', () => {
		const cmd = prepareInstallDirCommand(remote);
		expect(cmd).toContain("sudo mkdir -p '/opt/owlat'");
		expect(cmd).toContain('sudo chown');
	});

	it('build-setup-image builds the setup-cli Dockerfile under the dev tag', () => {
		const cmd = buildSetupImageCommand(remote);
		expect(cmd).toContain("cd '/opt/owlat'");
		expect(cmd).toContain('docker build -f apps/setup-cli/Dockerfile');
		expect(cmd).toContain(LOCAL_SETUP_IMAGE);
		expect(LOCAL_SETUP_IMAGE).toBe('ghcr.io/wolvesdotink/setup:dev');
	});

	it('installer in local-source mode pins the dev setup image and requests source builds', () => {
		const cmd = installerCommand({ ...remote, localSource: '/Users/dev/owlat' });
		expect(cmd).toContain('OWLAT_VERSION=dev');
		expect(cmd).toContain(`OWLAT_SETUP_IMAGE='${LOCAL_SETUP_IMAGE}'`);
		expect(cmd).toContain('OWLAT_BUILD_LOCAL=1');
		// Still the same non-interactive quickstart underneath.
		expect(cmd).toContain('OWLAT_PROGRESS=json OWLAT_ASSUME_YES=1');
		expect(cmd).toContain("--config '/opt/owlat/.owlat-setup.json'");
	});

	it('installer in push-images mode uses preloaded images instead of building', () => {
		const cmd = installerCommand({ ...remote, localSource: '/Users/dev/owlat', localImages: true });
		expect(cmd).toContain('OWLAT_LOCAL_IMAGES=1');
		expect(cmd).not.toContain('OWLAT_BUILD_LOCAL');
		expect(cmd).toContain('OWLAT_VERSION=dev');
	});

	it('maps uname arch to docker platforms', () => {
		expect(dockerPlatform('x86_64')).toBe('linux/amd64');
		expect(dockerPlatform('aarch64')).toBe('linux/arm64');
		expect(dockerPlatform('arm64')).toBe('linux/arm64');
	});

	it('derives the install source from remote options', () => {
		expect(installSource(remote)).toBe('git');
		expect(installSource({ ...remote, localSource: '/x' })).toBe('local-build');
		expect(installSource({ ...remote, localSource: '/x', localImages: true })).toBe('local-push');
	});

	it('config path is under the install dir', () => {
		expect(setupConfigPath('/srv/owlat')).toBe('/srv/owlat/.owlat-setup.json');
	});
});

describe('deriveNetworkUrls', () => {
	it('builds the owlat/api/rest.api subdomains for a domain', () => {
		expect(deriveNetworkUrls('example.com')).toEqual({
			siteUrl: 'https://owlat.example.com',
			convexUrl: 'https://api.example.com',
			convexSiteUrl: 'https://rest.api.example.com',
		});
	});

	it('strips a scheme and trailing slashes from the input', () => {
		expect(deriveNetworkUrls('https://example.com/').siteUrl).toBe('https://owlat.example.com');
	});
});

describe('deriveHostnames', () => {
	it('expands an apex domain into every owlat hostname', () => {
		expect(deriveHostnames('wolves.ink')).toEqual({
			site: 'owlat.wolves.ink',
			convex: 'api.wolves.ink',
			convexSite: 'rest.api.wolves.ink',
			mail: 'mail.wolves.ink',
			bounce: 'bounce.wolves.ink',
		});
	});

	it('builds network URLs from explicit (possibly overridden) hostnames', () => {
		expect(
			networkUrlsFromHosts({ site: 'app.x.com', convex: 'cx.x.com', convexSite: 'http.x.com' }),
		).toEqual({
			siteUrl: 'https://app.x.com',
			convexUrl: 'https://cx.x.com',
			convexSiteUrl: 'https://http.x.com',
		});
	});
});

describe('loopback detection', () => {
	it('flags loopback hostnames (the desktop can never reach a remote box at these)', () => {
		for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '0.0.0.0', '::1', '[::1]']) {
			expect(isLoopbackHost(h)).toBe(true);
		}
	});

	it('treats public hosts/IPs as non-loopback', () => {
		for (const h of ['owlat.wolves.ink', '203.0.113.5', 'vps.example.com']) {
			expect(isLoopbackHost(h)).toBe(false);
		}
		expect(isLoopbackHost('')).toBe(false);
	});

	it('parses full URLs and falls back to bare hosts', () => {
		expect(isLoopbackUrl('http://localhost:3000')).toBe(true);
		expect(isLoopbackUrl('https://127.0.0.1')).toBe(true);
		expect(isLoopbackUrl('https://owlat.wolves.ink')).toBe(false);
		expect(isLoopbackUrl('localhost')).toBe(true);
		expect(isLoopbackUrl('')).toBe(false);
		expect(isLoopbackUrl(null)).toBe(false);
	});
});

describe('canOpenWorkspaceUrl — the "success before usable" guard', () => {
	it('refuses a missing URL', () => {
		expect(canOpenWorkspaceUrl(null, true)).toBe(false);
		expect(canOpenWorkspaceUrl('', true)).toBe(false);
	});

	it('refuses a loopback URL even when "reachable" (a remote box at localhost is unreachable here)', () => {
		expect(canOpenWorkspaceUrl('http://localhost:3000', true)).toBe(false);
		expect(canOpenWorkspaceUrl('https://127.0.0.1', true)).toBe(false);
	});

	it('refuses a public URL that has not been confirmed reachable yet (DNS/TLS lag)', () => {
		expect(canOpenWorkspaceUrl('https://owlat.wolves.ink', false)).toBe(false);
	});

	it('allows a public URL only once it is confirmed reachable', () => {
		expect(canOpenWorkspaceUrl('https://owlat.wolves.ink', true)).toBe(true);
	});
});

describe('assessPassword — live length/strength read-out', () => {
	it('an empty password reads as empty with no filled segments', () => {
		const a = assessPassword('');
		expect(a.strength).toBe('empty');
		expect(a.meetsMinLength).toBe(false);
		expect(a.score).toBe(0);
	});

	it('anything under the minimum reads weak no matter how varied', () => {
		const a = assessPassword('aB3$xY'); // 6 chars, all 4 classes
		expect(a.meetsMinLength).toBe(false);
		expect(a.strength).toBe('weak');
		expect(a.label).toContain(`/${MIN_ADMIN_PASSWORD_LENGTH}`);
	});

	it('a long, varied password reads strong', () => {
		const a = assessPassword('Sup3rSecretPassphrase!');
		expect(a.meetsMinLength).toBe(true);
		expect(a.strength).toBe('strong');
		expect(a.score).toBe(4);
	});

	it('a bare-minimum low-variety password is fair, not strong', () => {
		const a = assessPassword('aaaaaaaaaaaa'); // exactly 12, one class
		expect(a.meetsMinLength).toBe(true);
		expect(a.strength).toBe('fair');
		expect(a.score).toBeLessThan(4);
	});
});

describe('validateAdminPassword — confirm + length gate', () => {
	it('rejects a too-short password before checking the match', () => {
		const r = validateAdminPassword('short', 'short');
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/at least 12/);
	});

	it('rejects a length-ok password whose confirmation differs', () => {
		const r = validateAdminPassword('a-very-long-password', 'a-very-long-passw0rd');
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/do not match/);
	});

	it('accepts a long password that matches its confirmation', () => {
		const r = validateAdminPassword('a-very-long-password', 'a-very-long-password');
		expect(r).toEqual({ ok: true, error: null });
	});
});

describe('server-IP resolution + DNS records', () => {
	const hosts = deriveHostnames('wolves.ink');

	it('recognises dotted-quad IPv4 and rejects hostnames / out-of-range octets', () => {
		expect(isIpv4('203.0.113.5')).toBe(true);
		expect(isIpv4(' 10.0.0.1 ')).toBe(true);
		expect(isIpv4('vps.example.com')).toBe(false);
		expect(isIpv4('999.0.0.1')).toBe(false);
		expect(isIpv4('203.0.113')).toBe(false);
	});

	it('recognises IPv6 and rejects junk', () => {
		expect(isIpv6('2001:db8::1')).toBe(true);
		expect(isIpv6('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(true);
		expect(isIpv6('::1')).toBe(true);
		expect(isIpv6('203.0.113.5')).toBe(false);
		expect(isIpv6('2001:db8::1::2')).toBe(false);
		expect(isIpv6('gggg::1')).toBe(false);
		expect(isIpv6('not-an-ip')).toBe(false);
	});

	it('parses the first valid IP line from remote probe output (v4 + v6)', () => {
		expect(parsePublicIp('203.0.113.5\n')).toBe('203.0.113.5');
		expect(parsePublicIp('  2001:db8::1  ')).toBe('2001:db8::1');
		expect(parsePublicIp('curl: (6) Could not resolve host\n203.0.113.5')).toBe('203.0.113.5');
	});

	it('returns null for empty or unparseable probe output (fail-soft)', () => {
		expect(parsePublicIp('')).toBeNull();
		expect(parsePublicIp('\n\n')).toBeNull();
		expect(parsePublicIp('command not found: curl')).toBeNull();
	});

	it('builds an injection-safe fixed public-IP probe command with a fallback', () => {
		const cmd = detectPublicIpCommand();
		expect(cmd).toContain('api.ipify.org');
		expect(cmd).toContain('ip route get 1.1.1.1');
		// Fixed string, no interpolation seams a caller could smuggle input through.
		expect(cmd).not.toContain('${');
		expect(cmd).not.toContain('`');
	});

	it('uses the SSH address when it is already an IP', () => {
		expect(resolveServerIp('203.0.113.5')).toBe('203.0.113.5');
	});

	it('accepts a detected IPv6 as the DNS target when connected by hostname', () => {
		expect(resolveServerIp('vps.example.com', '2001:db8::1')).toBe('2001:db8::1');
	});

	it('falls back to a supplied public IP when connected by hostname', () => {
		expect(resolveServerIp('vps.example.com', '198.51.100.7')).toBe('198.51.100.7');
	});

	it('returns null when neither the host nor the supplied IP is an address', () => {
		expect(resolveServerIp('vps.example.com', 'not-an-ip')).toBeNull();
		expect(resolveServerIp('vps.example.com')).toBeNull();
	});

	it('substitutes the real IP into every A record', () => {
		const rows = buildDnsRecords({ hosts, withMta: false, serverIp: '203.0.113.5' });
		expect(rows.every((r) => r.type !== 'A' || (r.value === '203.0.113.5' && !r.placeholder))).toBe(true);
	});

	it('flags A records as a placeholder (copy-disabled) when the IP is unknown', () => {
		const rows = buildDnsRecords({ hosts, withMta: false, serverIp: null });
		const aRecords = rows.filter((r) => r.type === 'A');
		expect(aRecords.every((r) => r.placeholder === true)).toBe(true);
		expect(aRecords.every((r) => r.value === SERVER_IP_PLACEHOLDER)).toBe(true);
	});

	it('surfaces SPF + DMARC (not just A/MX) for an MTA install so mail looks deliverable', () => {
		const rows = buildDnsRecords({ hosts, withMta: true, serverIp: '203.0.113.5' });
		const txts = rows.filter((r) => r.type === 'TXT');
		expect(txts.some((r) => r.value.startsWith('v=spf1'))).toBe(true);
		expect(rows.some((r) => r.type === 'TXT' && r.value.startsWith('v=DMARC1'))).toBe(true);
		expect(rows.some((r) => r.name === `_dmarc.${hosts.bounce}`)).toBe(true);
		expect(rows.some((r) => r.type === 'MX' && r.value === hosts.mail)).toBe(true);
		// PTR guidance rides along the mail A record as a note, not a fake record.
		expect(rows.find((r) => r.name === hosts.mail && r.type === 'A')?.note).toMatch(/PTR/);
	});

	it('omits the mail records entirely for a non-MTA provider', () => {
		const rows = buildDnsRecords({ hosts, withMta: false, serverIp: '203.0.113.5' });
		expect(rows.some((r) => r.type === 'MX' || r.type === 'TXT')).toBe(false);
	});
});

describe('secrets cleanup + failure tail', () => {
	it('removes the plaintext setup config from the install dir', () => {
		const cmd = removeSetupConfigCommand('/opt/owlat');
		expect(cmd).toBe("rm -f '/opt/owlat/.owlat-setup.json'");
	});

	it('keeps only the trailing stderr lines (root cause survives the cap)', () => {
		const logs = [
			{ stream: 'stdout' as const, line: 'building...' },
			{ stream: 'stderr' as const, line: 'warning 1' },
			{ stream: 'stdout' as const, line: 'still building' },
			{ stream: 'stderr' as const, line: 'fatal: out of memory' },
		];
		expect(stderrTail(logs, 40)).toEqual(['warning 1', 'fatal: out of memory']);
		// caps to the last N, preserving order
		expect(stderrTail(logs, 1)).toEqual(['fatal: out of memory']);
	});
});

describe('describeHostKey — TOFU vs changed-key (MITM)', () => {
	it('a CHANGED key demands an explicit extra confirmation and reads as dangerous', () => {
		const m = describeHostKey('mismatch');
		expect(m.isMismatch).toBe(true);
		expect(m.requiresExplicitConfirmation).toBe(true);
		expect(m.tone).toBe('danger');
		expect(m.title).toMatch(/CHANGED/);
	});

	it('a brand-new key is plain trust-on-first-use: a single accept, no extra opt-in', () => {
		const fresh = describeHostKey('new');
		expect(fresh.isMismatch).toBe(false);
		expect(fresh.requiresExplicitConfirmation).toBe(false);
		expect(fresh.tone).toBe('warn');
	});

	it('an already-trusted (match) key is not treated as a mismatch', () => {
		const ok = describeHostKey('match');
		expect(ok.isMismatch).toBe(false);
		expect(ok.requiresExplicitConfirmation).toBe(false);
	});
});
