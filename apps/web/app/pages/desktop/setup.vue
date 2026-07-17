<script setup lang="ts">
/**
 * Desktop "set up a new server" wizard. Reachable before any workspace exists
 * (see middleware/desktop-workspace.global.ts). Connects to a bare VPS over SSH,
 * collects configuration, then drives the installer with a live animated
 * timeline and finally connects the new instance as a workspace.
 */
import {
	deriveHostnames,
	networkUrlsFromHosts,
	describeHostKey,
	isLoopbackHost,
	isLoopbackUrl,
	defaultSubdomainLabels,
	validateSubdomainLabels,
	type HostKeyPrompt,
	type InstanceHostnames,
	type SetupConfigInput,
	type SubdomainLabels,
} from '~/lib/desktop/provisioning';
import {
	assessPassword,
	validateAdminPassword,
	resolveServerIp,
	buildDnsRecords,
	type DnsRecordRow,
} from '~/lib/desktop/provisioningForm';
import { computeSpfSuggestion, type SpfCoexistenceSuggestion } from '~/utils/spfCoexistence';

useHead({ title: 'Set up a server — Owlat' });
definePageMeta({ layout: false });

const { isDesktop } = useDesktopContext();
const {
	stage,
	steps,
	logs,
	connectInfo,
	summary,
	error,
	failureTail,
	secretsRemoved,
	busy,
	progress,
	siteUrl,
	publicIp: detectedPublicIp,
	canOpenWorkspace,
	connect,
	acceptHostKey,
	provision,
	verifySiteReachable,
	connectWorkspace,
	disconnect,
	retry,
} = useServerProvisioning();

// Release the SSH session + stop any reachability polling if the user navigates
// away mid-flow.
onBeforeUnmount(() => {
	stopReachPolling();
	if (spfLookupTimer) clearTimeout(spfLookupTimer);
	void disconnect();
});

// ---- connect form ----
const host = ref('');
const port = ref('22');
const username = ref('root');
const authMethod = ref<'key' | 'password'>('key');
const password = ref('');
// Key auth: point at a key file (read natively, `~` expanded) or paste the key.
const keySource = ref<'file' | 'paste'>('file');
const keyPath = ref('~/.ssh/id_ed25519');
const privateKey = ref('');
const passphrase = ref('');
const installDir = ref('/opt/owlat');
const branch = ref('main');
// Dev-only (`nuxt dev`, i.e. `tauri dev`): upload this machine's checkout
// instead of cloning the published repo and build all images on the server
// from that source. `import.meta.dev` is statically false in `generate:desktop`
// output, so the field is tree-shaken out of distributed builds.
const isDev = import.meta.dev;
const localSource = ref('');
// Where the dev images get built: on this machine (pushed over SSH — works on
// small servers) or on the server (needs ~4 GB RAM for the web build).
const imageMode = ref<'local' | 'server'>('local');
const showAdvanced = ref(false);
const connectError = ref('');

/** Host-key prompt copy + whether a CHANGED key needs the extra confirmation. */
const hostKeyPrompt = computed<HostKeyPrompt | null>(() =>
	connectInfo.value ? describeHostKey(connectInfo.value.knownHostStatus) : null,
);
// A changed (mismatch) key must be explicitly acknowledged before "Accept".
const mismatchAcknowledged = ref(false);
watch(
	() => connectInfo.value?.fingerprint,
	() => {
		mismatchAcknowledged.value = false;
	},
);

/**
 * Whether we're provisioning a REMOTE box (vs this machine). A remote server
 * with no public domain bakes SITE_URL=localhost, which the desktop can never
 * reach — so a domain is required for remote installs.
 */
const isRemoteTarget = computed(() => {
	const h = host.value.trim();
	return !!h && !isLoopbackHost(h);
});

/**
 * Paths pasted from a terminal (or dragged onto one) arrive shell-escaped
 * (`WLS\ -\ wolves`); the filesystem wants the literal form. Windows paths use
 * `\` as a separator, so only the escaped-space form is unescaped.
 */
function normalizeLocalPath(input: string): string {
	return input.trim().replace(/\\ /g, ' ');
}

/** Native file picker for the key path (starts in ~/.ssh). */
async function browseKeyFile() {
	try {
		const mod = await import('@owlat/desktop/src/dialog');
		const picked = await mod.pickSshKeyFile();
		if (picked) keyPath.value = picked;
	} catch {
		// Not running inside Tauri.
	}
}

async function onConnect() {
	connectError.value = '';
	if (!host.value.trim()) return (connectError.value = 'Enter the server address.');
	if (!username.value.trim()) return (connectError.value = 'Enter the SSH user.');
	if (authMethod.value === 'password' && !password.value) return (connectError.value = 'Enter the password.');
	if (authMethod.value === 'key' && keySource.value === 'file' && !keyPath.value.trim())
		return (connectError.value = 'Enter the path to your private key file.');
	if (authMethod.value === 'key' && keySource.value === 'paste' && !privateKey.value.trim())
		return (connectError.value = 'Paste your private key.');

	const auth =
		authMethod.value === 'key'
			? keySource.value === 'file'
				? ({ type: 'key', privateKeyPath: keyPath.value.trim(), passphrase: passphrase.value || undefined } as const)
				: ({ type: 'key', privateKey: privateKey.value, passphrase: passphrase.value || undefined } as const)
			: ({ type: 'password', password: password.value } as const);

	await connect({
		host: host.value.trim(),
		port: Number(port.value) || 22,
		username: username.value.trim(),
		auth,
		remote: {
			installDir: installDir.value.trim() || '/opt/owlat',
			branch: branch.value.trim() || 'main',
			...(isDev && localSource.value.trim()
				? { localSource: normalizeLocalPath(localSource.value), localImages: imageMode.value === 'local' }
				: {}),
		},
	});
}

// ---- config form ----
const packs = reactive({ emailClient: true, marketing: true, ai: false });
const packOptions = [
	{ key: 'emailClient', label: 'Email client' },
	{ key: 'marketing', label: 'Marketing' },
	{ key: 'ai', label: 'AI' },
] as const;
const sendingProvider = ref<'mta' | 'resend' | 'ses'>('mta');
const resendKey = ref('');
const sesRegion = ref('');
const sesAccessKey = ref('');
const sesSecret = ref('');
const aiProvider = ref<'none' | 'openrouter' | 'openai' | 'ollama'>('none');
const aiKey = ref('');
const adminEmail = ref('');
const adminName = ref('');
const adminPassword = ref('');
const adminPasswordConfirm = ref('');
const revealPassword = ref(false);
/** Live length + strength read-out shown as the admin password is typed. */
const passwordAssessment = computed(() => assessPassword(adminPassword.value));
/**
 * Inline password error shown live (before submit). Stays quiet until the user
 * has started typing both fields so the form doesn't shout on first render.
 */
const adminPasswordError = computed(() => {
	if (!adminPassword.value && !adminPasswordConfirm.value) return null;
	return validateAdminPassword(adminPassword.value, adminPasswordConfirm.value).error;
});
// One apex domain (e.g. wolves.ink) populates every hostname; the per-host
// overrides below are blank unless the user customises them.
const domain = ref('');
// When connected by hostname we don't know the server's public IP — the wizard
// auto-detects it over the live SSH session (see `detectedPublicIp`), but the
// operator can still override it here if detection failed or was wrong.
const publicIp = ref('');
// Prefill the manual-paste field with the value auto-detected over SSH, unless
// the operator has already typed one (never clobber their input, and fail-soft:
// an empty detection leaves the field blank for manual entry).
watch(detectedPublicIp, (detected) => {
	if (detected && !publicIp.value) publicIp.value = detected;
});
// The five subdomain labels (owlat / api / rest.api / mail / bounce), prefilled
// with their defaults and edited through the "customize hostnames" disclosure.
// They flow through deriveHostnames() — the single place labels become
// hostnames — so an override can't drift across the DNS records, generated
// config and network URLs.
const hostLabels = ref<SubdomainLabels>(defaultSubdomainLabels());
/** Per-field label validation (charset/length + mutual distinctness). */
const labelValidation = computed(() => validateSubdomainLabels(hostLabels.value));
const seedDemo = ref(false);
const configError = ref('');

/** Whether a domain has been entered (every hostname derives from it). */
const derivedHosts = computed<InstanceHostnames | null>(() =>
	domain.value.trim() ? deriveHostnames(domain.value) : null,
);

/** Hostnames for the entered domain with the current label overrides applied. */
const effectiveHosts = computed<InstanceHostnames | null>(() =>
	domain.value.trim() ? deriveHostnames(domain.value, hostLabels.value) : null,
);

function buildConfig(): SetupConfigInput {
	const cfg: SetupConfigInput = {
		version: 1,
		deploymentMode: 'selfhost',
		features: { packs: { ...packs } },
		admin: { email: adminEmail.value.trim(), name: adminName.value.trim(), password: adminPassword.value },
		seedDemo: seedDemo.value,
	};
	if (sendingProvider.value === 'mta') cfg.sending = { provider: 'mta' };
	else if (sendingProvider.value === 'resend') cfg.sending = { provider: 'resend', apiKey: resendKey.value.trim() };
	else cfg.sending = { provider: 'ses', region: sesRegion.value.trim(), accessKeyId: sesAccessKey.value.trim(), secretAccessKey: sesSecret.value.trim() };

	if (aiProvider.value === 'ollama') cfg.ai = { provider: 'ollama' };
	else if (aiProvider.value === 'openrouter') cfg.ai = { provider: 'openrouter', apiKey: aiKey.value.trim() };
	else if (aiProvider.value === 'openai') cfg.ai = { provider: 'openai', apiKey: aiKey.value.trim() };

	const hosts = effectiveHosts.value;
	if (hosts) {
		cfg.network = networkUrlsFromHosts(hosts);
		if (sendingProvider.value === 'mta') {
			cfg.domain = { ehloHostname: hosts.mail, bounceDomain: hosts.bounce };
		}
	}
	return cfg;
}

// ---- configure wizard steps ----
const configSteps = [
	{ id: 'features', label: 'Features', icon: 'lucide:blocks' },
	{ id: 'providers', label: 'Providers', icon: 'lucide:plug' },
	{ id: 'domain', label: 'Domain & DNS', icon: 'lucide:globe' },
	{ id: 'admin', label: 'Admin', icon: 'lucide:user-cog' },
] as const;
type ConfigStep = (typeof configSteps)[number]['id'];
const configStep = ref<ConfigStep>('features');
const stepIndex = computed(() => configSteps.findIndex((s) => s.id === configStep.value));
const isLastStep = computed(() => stepIndex.value === configSteps.length - 1);
function goStep(id: ConfigStep) {
	configStep.value = id;
}
function nextStep() {
	const next = configSteps[stepIndex.value + 1];
	if (next) configStep.value = next.id;
}
function prevStep() {
	const prev = configSteps[stepIndex.value - 1];
	if (prev) configStep.value = prev.id;
}

async function onProvision() {
	configError.value = '';
	// A remote server needs a public domain, otherwise the install bakes a
	// localhost URL the app can never open. Block before provisioning.
	if (isRemoteTarget.value && !derivedHosts.value) {
		configStep.value = 'domain';
		configError.value = 'Remote servers need a public domain so you can reach the app after install. Add one under Domain & DNS.';
		return;
	}
	// Customised hostname labels must be DNS-safe and mutually distinct, or the
	// derived hostnames/DNS records would collide or be invalid.
	if (!labelValidation.value.ok) {
		configStep.value = 'domain';
		configError.value = 'Fix the customised hostnames — each label must be a valid, distinct DNS label.';
		return;
	}
	// Admin fields live on the last step; jump there if they fail validation.
	const fail = (msg: string) => {
		configStep.value = 'admin';
		configError.value = msg;
	};
	if (!/^.+@.+\..+$/.test(adminEmail.value)) return fail('Enter a valid admin email.');
	if (!adminName.value.trim()) return fail('Enter an admin name.');
	const pw = validateAdminPassword(adminPassword.value, adminPasswordConfirm.value);
	if (!pw.ok) return fail(pw.error ?? 'Check the admin password.');
	await provision(buildConfig());
}

/**
 * The A-record target: the SSH address itself when it is an IP, else the public
 * IP the user supplied below, else null (the table flags a placeholder and
 * disables its copy button rather than handing over an un-pasteable string).
 */
const serverIp = computed(() => resolveServerIp(host.value, publicIp.value));
/** True when the SSH address is itself an IP (so no separate public-IP prompt is needed). */
const hostIsIp = computed(() => resolveServerIp(host.value, '') !== null);

/**
 * DNS records implied by the chosen public domain (+ MTA hostnames), shown
 * live in the form and again on the success screen. For an MTA install this
 * also surfaces starter SPF + DMARC records so the user does not assume the
 * A/MX records alone make mail deliverable.
 */
const dnsRecords = computed(() => {
	const hosts = effectiveHosts.value;
	if (!hosts) return [];
	return buildDnsRecords({ hosts, withMta: sendingProvider.value === 'mta', serverIp: serverIp.value });
});

/**
 * SPF coexistence: if the host where we'd publish the starter SPF record
 * already carries a foreign SPF record, publishing a second `v=spf1` is a
 * PermError (RFC 7208 §3.2). Resolve it (DoH) and, when a collision is found,
 * fold our mechanisms into the existing record. Fail-soft — no suggestion
 * leaves the starter value untouched.
 */
const isStarterSpf = (r: DnsRecordRow) => r.type === 'TXT' && r.value.startsWith('v=spf1');

/**
 * The only inputs the DoH lookup depends on — the SPF row's publish host + its
 * value — as a scalar key, so the watcher fires when those change rather than
 * on every `dnsRecords` recompute (packs/IP edits etc.).
 */
const spfLookupKey = computed(() => {
	const row = dnsRecords.value.find(isStarterSpf);
	return row ? `${row.name} ${row.value}` : '';
});

/**
 * A host complete enough to resolve: a dotted name with non-empty labels and a
 * ≥2-char alphabetic final label. Guards against firing DoH lookups against the
 * partial hostnames produced on every keystroke in the domain field.
 */
function looksResolvable(host: string): boolean {
	const labels = host.trim().split('.');
	if (labels.length < 2 || labels.some((label) => label === '')) return false;
	return /^[a-z]{2,}$/i.test(labels[labels.length - 1] ?? '');
}

const spfCoexistence = ref<SpfCoexistenceSuggestion | null>(null);
let spfLookupTimer: ReturnType<typeof setTimeout> | null = null;
watch(
	spfLookupKey,
	() => {
		spfCoexistence.value = null;
		if (spfLookupTimer) clearTimeout(spfLookupTimer);
		const row = dnsRecords.value.find(isStarterSpf);
		if (!row || !looksResolvable(row.name)) return;
		const { name, value } = row;
		// Debounce so typing in the domain field doesn't fire a DoH request per keystroke.
		spfLookupTimer = setTimeout(() => {
			void computeSpfSuggestion(name, value).then((result) => {
				// Ignore a slow DoH response if the SPF row changed meanwhile.
				const current = dnsRecords.value.find(isStarterSpf);
				if (result && current && current.name === name && current.value === value) {
					spfCoexistence.value = result;
				}
			});
		}, 450);
	},
	{ immediate: true },
);

/** DNS rows for display, with the starter SPF row merged into any existing one. */
const displayDnsRecords = computed<DnsRecordRow[]>(() => {
	const suggestion = spfCoexistence.value;
	if (!suggestion) return dnsRecords.value;
	return dnsRecords.value.map((r) =>
		isStarterSpf(r)
			? {
					...r,
					value: suggestion.merged,
					note: 'SPF — merged with the existing SPF record at this host so your other mail provider keeps working. SPF allows at most 10 DNS lookups — double-check it stays within that limit. Confirm in Settings → Domains.',
				}
			: r,
	);
});

const inConnect = computed(() => ['idle', 'connecting', 'hostkey', 'authenticating'].includes(stage.value));

/** The provisioned URL is a loopback address — unreachable from this app. */
const siteIsLoopback = computed(() => isLoopbackUrl(siteUrl.value));

// After the installer finishes, the public URL still needs DNS to resolve and
// TLS to be issued. Poll it so "Open workspace" only lights up once it answers,
// rather than declaring success too early.
const checkingReach = ref(false);
let reachTimer: ReturnType<typeof setInterval> | null = null;
function stopReachPolling(): void {
	if (reachTimer) {
		clearInterval(reachTimer);
		reachTimer = null;
	}
}
async function recheckReachable(): Promise<void> {
	if (checkingReach.value) return;
	checkingReach.value = true;
	try {
		await verifySiteReachable();
		if (canOpenWorkspace.value) stopReachPolling();
	} finally {
		checkingReach.value = false;
	}
}
watch(stage, (s) => {
	stopReachPolling();
	if (s === 'done' && siteUrl.value && !siteIsLoopback.value && !canOpenWorkspace.value) {
		void recheckReachable();
		reachTimer = setInterval(() => void recheckReachable(), 5000);
	}
});
const inputClass =
	'w-full rounded-lg border border-border-default bg-bg-deep px-3 py-2 text-sm text-text-primary focus:border-brand focus:outline-none';
const labelClass = 'mb-1 block text-xs font-medium text-text-secondary';
/** Section headers in the configure step (above groups of fields). */
const sectionClass = 'mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary';
const hintClass = 'mt-1.5 text-xs leading-relaxed text-text-secondary';
</script>

<template>
	<div class="min-h-screen bg-bg-deep text-text-primary" :class="{ 'pt-[38px]': isDesktop }">
		<DesktopTitlebar />
		<div class="mx-auto max-w-xl px-4 py-10">
			<div v-if="!isDesktop" class="rounded-2xl border border-border-default bg-bg-surface p-8 text-sm text-text-secondary">
				The server installer is only available in the desktop app.
			</div>

			<template v-else>
				<header class="mb-6">
					<NuxtLink to="/desktop/welcome" class="mb-4 inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary">
						<Icon name="lucide:arrow-left" class="size-3.5" /> Back
					</NuxtLink>
					<h1 class="text-2xl font-semibold">Set up a new server</h1>
					<p class="mt-1 text-sm text-text-secondary">
						Connect to a fresh Linux server over SSH and Owlat will install and configure itself.
					</p>
				</header>

				<!-- ============ CONNECT ============ -->
				<section v-if="inConnect" class="rounded-2xl border border-border-default bg-bg-surface p-6">
					<form class="space-y-4" @submit.prevent="onConnect">
						<div class="grid grid-cols-[1fr_5rem] gap-3">
							<div>
								<label class="mb-1 block text-xs font-medium text-text-secondary">Server address</label>
								<input v-model="host" :class="inputClass" placeholder="203.0.113.5 or vps.example.com" :disabled="busy" />
							</div>
							<div>
								<label :class="labelClass">Port</label>
								<input v-model="port" :class="inputClass" inputmode="numeric" :disabled="busy" />
							</div>
						</div>

						<div>
							<label :class="labelClass">SSH user</label>
							<input v-model="username" :class="inputClass" :disabled="busy" />
						</div>

						<div>
							<label :class="labelClass">Authentication</label>
							<div class="mb-2 inline-flex rounded-lg border border-border-default p-0.5 text-xs">
								<button
									type="button"
									class="rounded-md px-3 py-1"
									:class="authMethod === 'key' ? 'bg-brand text-white' : 'text-text-secondary'"
									@click="authMethod = 'key'"
								>
									Private key
								</button>
								<button
									type="button"
									class="rounded-md px-3 py-1"
									:class="authMethod === 'password' ? 'bg-brand text-white' : 'text-text-secondary'"
									@click="authMethod = 'password'"
								>
									Password
								</button>
							</div>

							<template v-if="authMethod === 'key'">
								<div v-if="keySource === 'file'" class="flex gap-2">
									<input
										v-model="keyPath"
										:class="[inputClass, 'font-mono text-xs']"
										placeholder="~/.ssh/id_ed25519"
										:disabled="busy"
									/>
									<button
										type="button"
										class="shrink-0 rounded-lg border border-border-default px-3 py-2 text-xs font-medium text-text-secondary hover:border-brand hover:text-text-primary"
										:disabled="busy"
										@click="browseKeyFile"
									>
										Browse…
									</button>
								</div>
								<textarea
									v-else
									v-model="privateKey"
									:class="[inputClass, 'h-28 resize-none font-mono text-xs']"
									placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
									:disabled="busy"
								/>
								<button
									type="button"
									class="mt-1.5 text-xs text-text-secondary hover:text-text-primary"
									:disabled="busy"
									@click="keySource = keySource === 'file' ? 'paste' : 'file'"
								>
									{{ keySource === 'file' ? 'Paste the key instead' : 'Use a key file instead' }}
								</button>
								<input
									v-model="passphrase"
									type="password"
									:class="[inputClass, 'mt-2']"
									placeholder="Key passphrase (optional)"
									:disabled="busy"
								/>
							</template>
							<input
								v-else
								v-model="password"
								type="password"
								:class="inputClass"
								placeholder="SSH password"
								:disabled="busy"
							/>
						</div>

						<button type="button" class="text-xs text-text-secondary hover:text-text-primary" @click="showAdvanced = !showAdvanced">
							{{ showAdvanced ? '− Hide' : '+ Show' }} advanced
						</button>
						<div v-if="showAdvanced" class="space-y-3">
							<div class="grid grid-cols-2 gap-3">
								<div>
									<label :class="labelClass">Install directory</label>
									<input v-model="installDir" :class="inputClass" :disabled="busy" />
								</div>
								<div>
									<label :class="labelClass">Branch</label>
									<input v-model="branch" :class="inputClass" :disabled="busy || !!localSource.trim()" />
								</div>
							</div>
							<div v-if="isDev">
								<label :class="labelClass">Local source folder (development)</label>
								<input
									v-model="localSource"
									:class="inputClass"
									placeholder="/path/to/your/owlat checkout (optional)"
									:disabled="busy"
								/>
								<p class="mt-1.5 text-xs text-text-secondary">
									Uploads this machine's checkout to the server — for testing the installer without a
									published repo or registry.
								</p>
								<div v-if="localSource.trim()" class="mt-3 space-y-1.5">
									<label class="flex cursor-pointer items-start gap-2.5 text-sm">
										<input v-model="imageMode" type="radio" value="local" class="peer sr-only" />
										<span
											class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg-surface"
											:class="imageMode === 'local' ? 'border-brand' : 'border-border-default'"
										>
											<span v-if="imageMode === 'local'" class="size-2 rounded-full bg-brand" />
										</span>
										<span>
											Build images on this machine
											<span class="block text-xs text-text-secondary">
												Needs Docker running here; images stream to the server over SSH. Works on small servers.
											</span>
										</span>
									</label>
									<label class="flex cursor-pointer items-start gap-2.5 text-sm">
										<input v-model="imageMode" type="radio" value="server" class="peer sr-only" />
										<span
											class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg-surface"
											:class="imageMode === 'server' ? 'border-brand' : 'border-border-default'"
										>
											<span v-if="imageMode === 'server'" class="size-2 rounded-full bg-brand" />
										</span>
										<span>
											Build images on the server
											<span class="block text-xs text-text-secondary">
												No local Docker needed, but the web build wants ~4&nbsp;GB RAM (or swap) on the server.
											</span>
										</span>
									</label>
								</div>
							</div>
						</div>

						<!-- host key confirmation -->
						<div
							v-if="stage === 'hostkey' && hostKeyPrompt"
							class="rounded-lg border p-3"
							:class="hostKeyPrompt.tone === 'danger' ? 'border-red-500/40 bg-red-500/5' : 'border-amber-500/30 bg-amber-500/5'"
						>
							<p class="text-sm font-medium" :class="hostKeyPrompt.tone === 'danger' ? 'text-red-300' : 'text-amber-300'">
								<Icon name="lucide:shield-alert" class="mb-0.5 mr-1 inline size-4" />
								{{ hostKeyPrompt.title }}
							</p>
							<p class="mt-1 text-xs text-text-secondary">{{ hostKeyPrompt.body }}</p>
							<code class="mt-2 block break-all rounded bg-bg-deep px-2 py-1 font-mono text-xs text-text-primary">{{ connectInfo?.fingerprint }}</code>

							<!-- A CHANGED key (possible interception) demands an explicit opt-in. -->
							<label
								v-if="hostKeyPrompt.requiresExplicitConfirmation"
								class="mt-3 flex cursor-pointer items-start gap-2 text-xs text-red-300"
							>
								<input v-model="mismatchAcknowledged" type="checkbox" class="mt-0.5" :disabled="busy" />
								<span>I know why this server's key changed and want to connect anyway.</span>
							</label>

							<button
								type="button"
								class="mt-3 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
								:class="hostKeyPrompt.tone === 'danger' ? 'bg-red-600' : 'bg-brand'"
								:disabled="busy || (hostKeyPrompt.requiresExplicitConfirmation && !mismatchAcknowledged)"
								@click="acceptHostKey(hostKeyPrompt.isMismatch)"
							>
								{{ hostKeyPrompt.isMismatch ? 'Accept changed key &amp; continue' : 'Accept &amp; continue' }}
							</button>
						</div>

						<p v-if="connectError" class="text-sm text-red-400">{{ connectError }}</p>
						<p v-if="error" class="text-sm text-red-400">{{ error }}</p>

						<button
							v-if="stage !== 'hostkey'"
							type="submit"
							:disabled="busy"
							class="w-full rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
						>
							<span v-if="stage === 'connecting'">Connecting…</span>
							<span v-else-if="stage === 'authenticating'">Authenticating…</span>
							<span v-else>Connect</span>
						</button>
					</form>
				</section>

				<!-- ============ CONFIGURE ============ -->
				<section v-else-if="stage === 'configure'" class="rounded-2xl border border-border-default bg-bg-surface p-6">
					<!-- step menu -->
					<nav class="mb-5 flex gap-1 rounded-lg border border-border-default p-1">
						<button
							v-for="(st, i) in configSteps"
							:key="st.id"
							type="button"
							class="flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
							:class="configStep === st.id ? 'bg-brand text-white' : 'text-text-secondary hover:text-text-primary'"
							@click="goStep(st.id)"
						>
							<Icon :name="st.icon" class="size-3.5 shrink-0" />
							<span class="hidden sm:inline">{{ st.label }}</span>
							<span class="sm:hidden">{{ i + 1 }}</span>
						</button>
					</nav>

					<form @submit.prevent="onProvision">
						<div v-show="configStep === 'features'">
							<label :class="sectionClass">Feature packs</label>
							<div class="space-y-1.5">
								<label
									v-for="opt in packOptions"
									:key="opt.key"
									class="flex cursor-pointer items-center gap-2.5 text-sm"
								>
									<input v-model="packs[opt.key]" type="checkbox" class="peer sr-only" />
									<span
										class="flex size-4 shrink-0 items-center justify-center rounded border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg-surface"
										:class="packs[opt.key] ? 'border-brand bg-brand' : 'border-border-default'"
									>
										<Icon v-if="packs[opt.key]" name="lucide:check" class="size-3 text-text-inverse" />
									</span>
									<span>{{ opt.label }}</span>
								</label>
							</div>
						</div>

						<div v-show="configStep === 'providers'">
							<label :class="sectionClass">Email sending</label>
							<div class="relative">
								<select v-model="sendingProvider" :class="[inputClass, 'appearance-none pr-8']">
									<option value="mta">Owlat MTA (self-hosted)</option>
									<option value="resend">Resend</option>
									<option value="ses">Amazon SES</option>
								</select>
								<Icon name="lucide:chevron-down" class="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary" />
							</div>
							<input v-if="sendingProvider === 'resend'" v-model="resendKey" :class="[inputClass, 'mt-2']" placeholder="Resend API key (re_…)" />
							<div v-if="sendingProvider === 'ses'" class="mt-2 space-y-2">
								<input v-model="sesRegion" :class="inputClass" placeholder="AWS region (us-east-1)" />
								<input v-model="sesAccessKey" :class="inputClass" placeholder="Access key ID" />
								<input v-model="sesSecret" type="password" :class="inputClass" placeholder="Secret access key" />
							</div>
							<p v-if="sendingProvider === 'mta'" :class="hintClass">
								Mail hostnames (<span class="font-mono">mail.</span> for outbound, <span class="font-mono">bounce.</span>
								for returns) come from the domain you set below.
							</p>
						</div>

						<div v-show="configStep === 'providers'" class="mt-5">
							<label :class="sectionClass">AI (optional)</label>
							<div class="relative">
								<select v-model="aiProvider" :class="[inputClass, 'appearance-none pr-8']">
									<option value="none">None</option>
									<option value="openrouter">OpenRouter</option>
									<option value="openai">OpenAI</option>
									<option value="ollama">Ollama (local)</option>
								</select>
								<Icon name="lucide:chevron-down" class="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary" />
							</div>
							<input
								v-if="aiProvider === 'openrouter' || aiProvider === 'openai'"
								v-model="aiKey"
								:class="[inputClass, 'mt-2']"
								placeholder="API key"
							/>
						</div>

						<div v-show="configStep === 'admin'">
							<label :class="sectionClass">Admin account</label>
							<div class="space-y-2">
								<input v-model="adminEmail" :class="inputClass" placeholder="admin@example.com" />
								<input v-model="adminName" :class="inputClass" placeholder="Your name" />
								<div class="relative">
									<input
										v-model="adminPassword"
										:type="revealPassword ? 'text' : 'password'"
										:class="[inputClass, 'pr-10']"
										autocomplete="new-password"
										placeholder="Password (min 12 chars)"
									/>
									<button
										type="button"
										class="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
										:aria-label="revealPassword ? 'Hide password' : 'Show password'"
										:aria-pressed="revealPassword"
										@click="revealPassword = !revealPassword"
									>
										<Icon :name="revealPassword ? 'lucide:eye-off' : 'lucide:eye'" class="size-4" />
									</button>
								</div>
								<input
									v-model="adminPasswordConfirm"
									:type="revealPassword ? 'text' : 'password'"
									:class="inputClass"
									autocomplete="new-password"
									placeholder="Confirm password"
								/>
								<!-- Live length + strength meter (validates before submit). -->
								<div v-if="adminPassword" class="flex items-center gap-2">
									<div class="flex h-1 flex-1 gap-1">
										<span
											v-for="seg in 4"
											:key="seg"
											class="h-full flex-1 rounded-full transition-colors"
											:class="seg <= passwordAssessment.score
												? (passwordAssessment.strength === 'strong'
													? 'bg-emerald-400'
													: passwordAssessment.strength === 'fair'
														? 'bg-amber-400'
														: 'bg-red-400')
												: 'bg-border-default'"
										/>
									</div>
									<span
										class="w-20 shrink-0 text-right text-xs"
										:class="passwordAssessment.meetsMinLength ? 'text-text-secondary' : 'text-red-400'"
									>{{ passwordAssessment.label }}</span>
								</div>
								<p v-if="adminPasswordError" class="text-xs text-red-400">{{ adminPasswordError }}</p>
							</div>
						</div>

						<div v-show="configStep === 'domain'">
							<label :class="sectionClass">Domain{{ isRemoteTarget ? ' (required for a remote server)' : ' (for remote access)' }}</label>
							<input v-model="domain" :class="inputClass" :placeholder="isRemoteTarget ? 'wolves.ink' : 'wolves.ink (optional)'" />
							<p class="mt-1.5 text-xs text-text-secondary">
								Enter one domain — Owlat derives every hostname from it (app, API, mail).
								<template v-if="isRemoteTarget">
									A remote server needs a domain so you can open it from this app after install — its
									own <span class="font-mono">localhost</span> is not reachable from here.
								</template>
								<template v-else>
									Leave blank only when installing on this machine.
								</template>
							</p>
							<p v-if="isRemoteTarget && !derivedHosts" class="mt-1.5 text-xs text-amber-300">
								<Icon name="lucide:triangle-alert" class="mb-0.5 mr-1 inline size-3.5" />
								Without a domain this install is only reachable on the server itself.
							</p>

							<!-- Connected by hostname → the SSH address is not an IP. The wizard
							     auto-detects the public IP over the SSH session; this field lets
							     the operator override it if detection failed or was wrong. -->
							<div v-if="derivedHosts && !hostIsIp" class="mt-3">
								<label :class="labelClass">Server's public IP (for the A records)</label>
								<input v-model="publicIp" :class="[inputClass, 'font-mono text-xs']" placeholder="203.0.113.5" inputmode="decimal" />
								<p class="mt-1 text-xs text-text-secondary">
									You connected by hostname. We try to read the server's public IP over the SSH session and
									fill it in here; if that's blank or wrong, paste it from your host's dashboard so the A
									records show a real, copyable address.
								</p>
							</div>

							<div>
								<div v-if="derivedHosts" class="mt-2">
									<DesktopHostnameOverrides
										v-model="hostLabels"
										:domain="domain"
										:errors="labelValidation.errors"
									/>
								</div>

								<div class="mt-3 overflow-x-auto rounded-lg border border-border-subtle bg-bg-deep p-3">
									<p class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
										DNS records to create
									</p>
									<DesktopDnsRecordList v-if="dnsRecords.length" :records="displayDnsRecords" />
									<p v-else class="text-xs text-text-secondary">
										Enter a domain above to see the records you need.
										<template v-if="isRemoteTarget"> A remote server needs one to be reachable from this app.</template>
										<template v-else> Leave it blank for a local install on this machine (no DNS required).</template>
									</p>
									<p v-if="dnsRecords.length" class="mt-2 text-xs text-text-secondary">
										TLS certificates are issued automatically once these resolve — keep ports 80/443 open.
									</p>
									<p v-if="sendingProvider === 'mta' && dnsRecords.length" class="mt-1.5 text-xs text-amber-300">
										<Icon name="lucide:info" class="mb-0.5 mr-1 inline size-3.5" />
										These get the app online. For deliverable email, finish SPF, DKIM and DMARC in
										<span class="font-medium">Settings → Domains</span> after first sign-in — DKIM is generated there.
									</p>
								</div>
							</div>
						</div>

						<label v-show="configStep === 'admin'" class="mt-4 flex cursor-pointer items-center gap-2.5 text-sm">
							<input v-model="seedDemo" type="checkbox" class="peer sr-only" />
							<span
								class="flex size-4 shrink-0 items-center justify-center rounded border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg-surface"
								:class="seedDemo ? 'border-brand bg-brand' : 'border-border-default'"
							>
								<Icon v-if="seedDemo" name="lucide:check" class="size-3 text-text-inverse" />
							</span>
							<span>Seed demo data (for evaluating)</span>
						</label>

						<p v-if="configError" class="mt-4 text-sm text-red-400">{{ configError }}</p>
						<div class="mt-5 flex items-center gap-3 border-t border-border-default pt-4">
							<button
								v-if="stepIndex > 0"
								type="button"
								class="rounded-lg border border-border-default px-3 py-2 text-sm text-text-secondary hover:border-brand hover:text-text-primary"
								@click="prevStep"
							>
								Back
							</button>
							<button
								v-if="!isLastStep"
								type="button"
								class="ml-auto rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white"
								@click="nextStep"
							>
								Next
							</button>
							<button
								v-else
								type="submit"
								class="ml-auto rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white"
							>
								Provision server
							</button>
						</div>
					</form>
				</section>

				<!-- ============ PROVISION / DONE / ERROR ============ -->
				<section v-else class="rounded-2xl border border-border-default bg-bg-surface p-6">
					<DesktopProvisioningTimeline :steps="steps" :logs="logs" :progress="progress" />

					<!-- READY: the public URL is up and reachable -->
					<div v-if="stage === 'done' && canOpenWorkspace" class="mt-6 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
						<p class="flex items-center gap-2 text-sm font-medium text-emerald-300">
							<Icon name="lucide:party-popper" class="size-4" /> Your server is ready
						</p>
						<p v-if="siteUrl" class="mt-1 text-xs text-text-secondary">{{ siteUrl }}</p>
						<button
							class="mt-3 w-full rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white"
							@click="connectWorkspace"
						>
							Open workspace
						</button>
					</div>

					<!-- FINISHING UP: installed, but the public URL isn't answering yet (DNS/TLS) -->
					<div v-else-if="stage === 'done' && !siteIsLoopback" class="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
						<p class="flex items-center gap-2 text-sm font-medium text-amber-300">
							<Icon name="lucide:loader-circle" class="size-4" :class="{ 'animate-spin': checkingReach }" />
							Finishing up — add your DNS records, then open your workspace
						</p>
						<p class="mt-1 text-xs text-text-secondary">
							Owlat is installed at <span class="font-mono">{{ siteUrl }}</span>, but the address can't be
							reached yet. Create the records below; once they resolve and TLS is issued, this turns into
							"Open workspace" automatically.
						</p>
						<div v-if="dnsRecords.length" class="mt-3 overflow-x-auto rounded-lg border border-border-subtle bg-bg-deep p-3">
							<p class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
								Create these DNS records
							</p>
							<DesktopDnsRecordList :records="displayDnsRecords" />
							<p class="mt-2 text-xs text-text-secondary">
								TLS is issued automatically once they resolve (ports 80/443 open).
							</p>
						</div>
						<button
							class="mt-3 inline-flex items-center gap-2 rounded-lg border border-border-default px-3 py-2 text-sm hover:border-brand disabled:opacity-60"
							:disabled="checkingReach"
							@click="recheckReachable"
						>
							<Icon name="lucide:refresh-cw" class="size-3.5" :class="{ 'animate-spin': checkingReach }" />
							{{ checkingReach ? 'Checking…' : 'Check again' }}
						</button>
					</div>

					<!-- LOOPBACK: the URL only works on the server itself -->
					<div v-else-if="stage === 'done'" class="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
						<p class="flex items-center gap-2 text-sm font-medium text-amber-300">
							<Icon name="lucide:circle-check" class="size-4" /> Your server is running
						</p>
						<p class="mt-1 text-xs text-text-secondary">
							It's installed at <span class="font-mono">{{ siteUrl }}</span>, but that address only works on
							the server itself — not from this app. Re-run setup with a public domain to open it here.
						</p>
						<button
							class="mt-3 inline-block rounded-lg border border-border-default px-3 py-2 text-sm hover:border-brand"
							@click="retry"
						>
							Set a domain &amp; retry
						</button>
					</div>

					<!-- After any successful install: note the fate of the secrets-bearing config. -->
					<div v-if="stage === 'done'" class="mt-3 flex items-start gap-2 text-xs text-text-secondary">
						<Icon :name="secretsRemoved ? 'lucide:shield-check' : 'lucide:shield-alert'" class="mt-0.5 size-3.5 shrink-0" :class="secretsRemoved ? 'text-emerald-400' : 'text-amber-300'" />
						<span v-if="secretsRemoved">
							The setup file — which held your admin password and provider API keys in plaintext — was
							removed from the server.
						</span>
						<span v-else class="text-amber-300">
							Couldn't auto-remove the setup file. It holds your admin password and provider keys in
							plaintext — delete <span class="font-mono">.owlat-setup.json</span> from the install directory.
						</span>
					</div>

					<div v-else-if="stage === 'error'" class="mt-6 rounded-lg border border-red-500/30 bg-red-500/5 p-4">
						<p class="text-sm font-medium text-red-300">Provisioning failed</p>
						<p class="mt-1 text-xs text-text-secondary">{{ error }}</p>
						<!-- The failing step's stderr tail, pinned so the root cause stays readable. -->
						<div v-if="failureTail.length" class="mt-2">
							<p class="mb-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">Last error output</p>
							<pre class="max-h-40 overflow-auto rounded bg-bg-deep p-2 font-mono text-[11px] leading-snug text-red-300">{{ failureTail.join('\n') }}</pre>
						</div>
						<p class="mt-2 text-xs text-text-secondary">Open the server log above for the full details, then adjust your configuration and try again.</p>
						<button
							class="mt-3 inline-block rounded-lg border border-border-default px-3 py-2 text-sm hover:border-brand"
							@click="retry"
						>
							Adjust &amp; retry
						</button>
					</div>
				</section>
			</template>
		</div>
	</div>
</template>
