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
	SUBDOMAIN_KEYS,
	type HostKeyPrompt,
	type InstanceHostnames,
	type SetupConfigInput,
	type SubdomainKey,
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

const { t } = useI18n();

/**
 * Registry-supplied copy (host-key prompts, password assessment) arrives as a
 * message key, optionally with interpolation params — render either shape.
 */
type MessageRef = string | { key: string; params?: Record<string, unknown> };
const tk = (message: MessageRef | null | undefined): string =>
	!message ? '' : typeof message === 'string' ? t(message) : t(message.key, message.params ?? {});

useHead({ title: () => t('desktop.setup.pageTitle') });
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
	if (!host.value.trim()) return (connectError.value = t('desktop.setup.errors.hostRequired'));
	if (!username.value.trim()) return (connectError.value = t('desktop.setup.errors.usernameRequired'));
	if (authMethod.value === 'password' && !password.value) return (connectError.value = t('desktop.setup.errors.passwordRequired'));
	if (authMethod.value === 'key' && keySource.value === 'file' && !keyPath.value.trim())
		return (connectError.value = t('desktop.setup.errors.keyPathRequired'));
	if (authMethod.value === 'key' && keySource.value === 'paste' && !privateKey.value.trim())
		return (connectError.value = t('desktop.setup.errors.privateKeyRequired'));

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
	{ key: 'emailClient', label: 'desktop.setup.packs.emailClient' },
	{ key: 'marketing', label: 'desktop.setup.packs.marketing' },
	{ key: 'ai', label: 'desktop.setup.packs.ai' },
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
//
// The disclosure deliberately overrides the LABEL, not a full hostname: the
// whole wizard is built around one apex domain (the domain field, the DNS
// record table, SPF coexistence and A-record IP detection all assume it), so a
// cross-apex hostname (e.g. app.other-domain.com) would need per-host DNS
// guidance the wizard doesn't model. That split-apex case stays reachable by
// hand-editing the generated config (network.*/domain.* are free strings); the
// wizard trades it away for a UI that can't produce an unreachable host.
const hostLabels = ref<SubdomainLabels>(defaultSubdomainLabels());
// mail/bounce are inert without the self-hosted MTA (nothing consumes those
// hostnames), so they are disabled — not validated or gated — for other
// providers, and only the live labels are checked for distinctness.
const HOST_LABEL_INACTIVE_HINT = 'desktop.setup.hostLabels.inactiveHint';
const disabledLabelKeys = computed<SubdomainKey[]>(() =>
	sendingProvider.value === 'mta' ? [] : ['mail', 'bounce'],
);
const activeLabelKeys = computed<SubdomainKey[]>(() =>
	SUBDOMAIN_KEYS.filter((k) => !disabledLabelKeys.value.includes(k)),
);
/** Per-field label validation (charset/length + mutual distinctness) of the live labels. */
const labelValidation = computed(() => validateSubdomainLabels(hostLabels.value, activeLabelKeys.value));
const seedDemo = ref(false);
const configError = ref('');

/** Whether a domain has been entered (every hostname derives from it). */
const hasDomain = computed(() => !!domain.value.trim());

/** Hostnames for the entered domain with the current label overrides applied. */
const effectiveHosts = computed<InstanceHostnames | null>(() =>
	hasDomain.value ? deriveHostnames(domain.value, hostLabels.value) : null,
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
	{ id: 'features', label: 'desktop.setup.steps.features', icon: 'lucide:blocks' },
	{ id: 'providers', label: 'desktop.setup.steps.providers', icon: 'lucide:plug' },
	{ id: 'domain', label: 'desktop.setup.steps.domain', icon: 'lucide:globe' },
	{ id: 'admin', label: 'desktop.setup.steps.admin', icon: 'lucide:user-cog' },
] as const;
type ConfigStep = (typeof configSteps)[number]['id'];
const stepOptions = computed(() => configSteps.map((s) => ({ value: s.id, label: t(s.label) })));
const authOptions = computed(() => [
	{ value: 'key', label: t('desktop.setup.auth.key') },
	{ value: 'password', label: t('desktop.setup.auth.password') },
]);
// Step navigation is the shared wizard composable, not a second hand-rolled
// copy of it. The step is deliberately NOT synced to the URL here: the SSH
// session this wizard configures lives only in memory, so a reload drops back
// to Connect and a shareable `?step=admin` would be a link to a wizard that is
// not running.
const {
	currentStep: configStep,
	currentStepIndex: stepIndex,
	isLastStep,
	goToStep: goStep,
	goToNext: nextStep,
	goToPrevious: prevStep,
} = useWizard<ConfigStep>(
	configSteps.map((step, index) => ({ id: step.id, label: step.label, number: index + 1 }))
);

async function onProvision() {
	configError.value = '';
	// A remote server needs a public domain, otherwise the install bakes a
	// localhost URL the app can never open. Block before provisioning.
	if (isRemoteTarget.value && !hasDomain.value) {
		configStep.value = 'domain';
		configError.value = t('desktop.setup.errors.domainRequired');
		return;
	}
	// Customised hostname labels must be DNS-safe and mutually distinct, or the
	// derived hostnames/DNS records would collide or be invalid.
	if (!labelValidation.value.ok) {
		configStep.value = 'domain';
		configError.value = t('desktop.setup.errors.invalidHostLabels');
		return;
	}
	// Admin fields live on the last step; jump there if they fail validation.
	const fail = (msg: string) => {
		configStep.value = 'admin';
		configError.value = msg;
	};
	if (!/^.+@.+\..+$/.test(adminEmail.value)) return fail(t('desktop.setup.errors.adminEmailInvalid'));
	if (!adminName.value.trim()) return fail(t('desktop.setup.errors.adminNameRequired'));
	const pw = validateAdminPassword(adminPassword.value, adminPasswordConfirm.value);
	if (!pw.ok) return fail(tk(pw.error) || t('desktop.setup.errors.adminPasswordInvalid'));
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
	return row ? `${row.name}\u0000${row.value}` : '';
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
					note: 'desktop.setup.dns.spfMergedNote',
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
// Shared design-system input (packages/ui components.css) — same recipe the
// dashboard and the marketing site build on.
const inputClass = 'input input-sm text-sm';
const labelClass = 'mb-1 block text-xs font-medium text-text-secondary';
/** Section headers in the configure step (above groups of fields). */
const sectionClass = 'mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary';
const hintClass = 'mt-1.5 text-xs leading-relaxed text-text-secondary';
</script>

<template>
	<div class="min-h-screen bg-bg-deep text-text-primary" :class="{ 'pt-[38px]': isDesktop }">
		<DesktopTitlebar />
		<div class="mx-auto max-w-xl px-4 py-10">
			<div v-if="!isDesktop" class="card p-8 text-sm text-text-secondary">
				{{ t('desktop.setup.desktopOnly') }}
			</div>

			<template v-else>
				<header class="mb-6">
					<NuxtLink to="/desktop/welcome" class="mb-4 inline-flex items-center gap-1 text-xs text-text-secondary transition-colors duration-(--motion-fast) hover:text-text-primary">
						<Icon name="lucide:arrow-left" class="size-3.5" /> {{ t('common.back') }}
					</NuxtLink>
					<I18nT keypath="desktop.setup.heading" tag="h1" class="text-3xl font-medium tracking-[-0.02em] text-text-primary" scope="global">
							<template #accent><span class="font-display italic">{{ t('desktop.setup.headingAccent') }}</span></template>
						</I18nT>
						<p class="mt-2 text-md leading-[1.65] text-text-secondary">
							{{ t('desktop.setup.subtitle') }}
						</p>
				</header>

				<!-- ============ CONNECT ============ -->
				<section v-if="inConnect" class="card">
					<form class="space-y-4" @submit.prevent="onConnect">
						<div class="grid grid-cols-[1fr_5rem] gap-3">
							<div>
								<label class="mb-1 block text-xs font-medium text-text-secondary">{{ t('desktop.setup.fields.host') }}</label>
									<input v-model="host" :class="inputClass" :placeholder="t('desktop.setup.fields.hostPlaceholder')" :disabled="busy" />
							</div>
							<div>
								<label :class="labelClass">{{ t('desktop.setup.fields.port') }}</label>
								<input v-model="port" :class="inputClass" inputmode="numeric" :disabled="busy" />
							</div>
						</div>

						<div>
							<label :class="labelClass">{{ t('desktop.setup.fields.sshUser') }}</label>
							<input v-model="username" :class="inputClass" :disabled="busy" />
						</div>

						<div>
							<label :class="labelClass">{{ t('desktop.setup.fields.authentication') }}</label>
							<div class="mb-2 inline-block" role="group" :aria-label="t('desktop.setup.fields.authMethod')">
								<UiSegmentedControl
									size="sm"
									:options="authOptions"
									:model-value="authMethod"
									@update:model-value="authMethod = $event as 'key' | 'password'"
								/>
							</div>

							<template v-if="authMethod === 'key'">
								<div v-if="keySource === 'file'" class="flex gap-2">
									<input
										v-model="keyPath"
										:class="[inputClass, 'font-mono text-xs']"
										placeholder="~/.ssh/id_ed25519"
										:disabled="busy"
									/>
									<UiButton variant="outline" size="sm" class="shrink-0" :disabled="busy" @click="browseKeyFile">
											{{ t('desktop.setup.fields.browse') }}
										</UiButton>
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
									{{ keySource === 'file' ? t('desktop.setup.fields.pasteKeyInstead') : t('desktop.setup.fields.useKeyFileInstead') }}
								</button>
								<input
									v-model="passphrase"
									type="password"
									:class="[inputClass, 'mt-2']"
									:placeholder="t('desktop.setup.fields.passphrasePlaceholder')"
									:disabled="busy"
								/>
							</template>
							<input
								v-else
								v-model="password"
								type="password"
								:class="inputClass"
								:placeholder="t('desktop.setup.fields.sshPasswordPlaceholder')"
								:disabled="busy"
							/>
						</div>

						<button type="button" class="text-xs text-text-secondary hover:text-text-primary" @click="showAdvanced = !showAdvanced">
							{{ showAdvanced ? t('desktop.setup.hideAdvanced') : t('desktop.setup.showAdvanced') }}
						</button>
						<div v-if="showAdvanced" class="space-y-3">
							<div class="grid grid-cols-2 gap-3">
								<div>
									<label :class="labelClass">{{ t('desktop.setup.fields.installDir') }}</label>
									<input v-model="installDir" :class="inputClass" :disabled="busy" />
								</div>
								<div>
									<label :class="labelClass">{{ t('desktop.setup.fields.branch') }}</label>
									<input v-model="branch" :class="inputClass" :disabled="busy || !!localSource.trim()" />
								</div>
							</div>
							<div v-if="isDev">
								<label :class="labelClass">{{ t('desktop.setup.fields.localSource') }}</label>
								<input
									v-model="localSource"
									:class="inputClass"
									:placeholder="t('desktop.setup.fields.localSourcePlaceholder')"
									:disabled="busy"
								/>
								<p class="mt-1.5 text-xs text-text-secondary">
										{{ t('desktop.setup.fields.localSourceHint') }}
									</p>
								<div v-if="localSource.trim()" class="mt-3 space-y-1.5">
									<label class="flex cursor-pointer items-start gap-2.5 text-sm">
										<input v-model="imageMode" type="radio" value="local" class="peer sr-only" />
										<span
											class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-2"
											:class="imageMode === 'local' ? 'border-brand' : 'border-border-default'"
										>
											<span v-if="imageMode === 'local'" class="size-2 rounded-full bg-brand" />
										</span>
										<span>
												{{ t('desktop.setup.imageMode.localTitle') }}
												<span class="block text-xs text-text-secondary">
													{{ t('desktop.setup.imageMode.localHint') }}
												</span>
											</span>
									</label>
									<label class="flex cursor-pointer items-start gap-2.5 text-sm">
										<input v-model="imageMode" type="radio" value="server" class="peer sr-only" />
										<span
											class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-2"
											:class="imageMode === 'server' ? 'border-brand' : 'border-border-default'"
										>
											<span v-if="imageMode === 'server'" class="size-2 rounded-full bg-brand" />
										</span>
										<span>
												{{ t('desktop.setup.imageMode.serverTitle') }}
												<span class="block text-xs text-text-secondary">
													{{ t('desktop.setup.imageMode.serverHint') }}
												</span>
											</span>
									</label>
								</div>
							</div>
						</div>

						<!-- host key confirmation -->
						<div
							v-if="stage === 'hostkey' && hostKeyPrompt"
							class="rounded-xl border p-3"
							:class="hostKeyPrompt.tone === 'danger' ? 'border-error/40 bg-error/5' : 'border-warning/40 bg-warning/5'"
						>
							<p class="text-sm font-medium" :class="hostKeyPrompt.tone === 'danger' ? 'text-error' : 'text-warning'">
								<Icon name="lucide:shield-alert" class="mb-0.5 mr-1 inline size-4" />
								{{ tk(hostKeyPrompt.title) }}
							</p>
							<p class="mt-1 text-xs text-text-secondary">{{ tk(hostKeyPrompt.body) }}</p>
							<code class="mt-2 block break-all rounded bg-bg-deep px-2 py-1 font-mono text-xs text-text-primary">{{ connectInfo?.fingerprint }}</code>

							<!-- A CHANGED key (possible interception) demands an explicit opt-in. -->
							<label
								v-if="hostKeyPrompt.requiresExplicitConfirmation"
								class="mt-3 flex cursor-pointer items-start gap-2 text-xs text-error"
							>
								<input v-model="mismatchAcknowledged" type="checkbox" class="mt-0.5" :disabled="busy" />
								<span>{{ t('desktop.setup.hostKey.acknowledge') }}</span>
							</label>

							<UiButton
								size="sm"
								class="mt-3"
								:variant="hostKeyPrompt.tone === 'danger' ? 'danger' : 'primary'"
								:disabled="busy || (hostKeyPrompt.requiresExplicitConfirmation && !mismatchAcknowledged)"
								@click="acceptHostKey(hostKeyPrompt.isMismatch)"
							>
								{{ hostKeyPrompt.isMismatch ? t('desktop.setup.hostKey.acceptChanged') : t('desktop.setup.hostKey.accept') }}
							</UiButton>
						</div>

						<p v-if="connectError" class="text-sm text-error">{{ connectError }}</p>
						<p v-if="error" class="text-sm text-error">{{ error }}</p>

						<UiButton v-if="stage !== 'hostkey'" type="submit" :disabled="busy" full-width>
							<span v-if="stage === 'connecting'">{{ t('desktop.setup.connecting') }}</span>
								<span v-else-if="stage === 'authenticating'">{{ t('desktop.setup.authenticating') }}</span>
								<span v-else>{{ t('desktop.setup.connect') }}</span>
						</UiButton>
					</form>
				</section>

				<!-- ============ CONFIGURE ============ -->
				<section v-else-if="stage === 'configure'" class="card">
					<!-- step menu -->
					<nav class="mb-5" :aria-label="t('desktop.setup.stepsLabel')">
						<UiSegmentedControl
							:options="stepOptions"
							:model-value="configStep"
							@update:model-value="goStep($event as ConfigStep)"
						>
							<template v-for="st in configSteps" :key="st.id" #[`option-${st.id}`]>
								<Icon :name="st.icon" class="size-3.5 shrink-0" />
								<span class="hidden sm:inline">{{ t(st.label) }}</span>
							</template>
						</UiSegmentedControl>
					</nav>

					<form @submit.prevent="onProvision">
						<div v-show="configStep === 'features'">
							<label :class="sectionClass">{{ t('desktop.setup.sections.featurePacks') }}</label>
							<div class="space-y-1.5">
								<label
									v-for="opt in packOptions"
									:key="opt.key"
									class="flex cursor-pointer items-center gap-2.5 text-sm"
								>
									<input v-model="packs[opt.key]" type="checkbox" class="peer sr-only" />
									<span
										class="flex size-4 shrink-0 items-center justify-center rounded border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-2"
										:class="packs[opt.key] ? 'border-brand bg-brand' : 'border-border-default'"
									>
										<Icon v-if="packs[opt.key]" name="lucide:check" class="size-3 text-text-inverse" />
									</span>
									<span>{{ t(opt.label) }}</span>
								</label>
							</div>
						</div>

						<div v-show="configStep === 'providers'">
							<label :class="sectionClass">{{ t('desktop.setup.sections.emailSending') }}</label>
							<div class="relative">
								<select v-model="sendingProvider" :class="[inputClass, 'appearance-none pr-8']">
									<option value="mta">{{ t('desktop.setup.sending.mta') }}</option>
										<option value="resend">{{ t('desktop.setup.sending.resend') }}</option>
										<option value="ses">{{ t('desktop.setup.sending.ses') }}</option>
								</select>
								<Icon name="lucide:chevron-down" class="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary" />
							</div>
							<input v-if="sendingProvider === 'resend'" v-model="resendKey" :class="[inputClass, 'mt-2']" :placeholder="t('desktop.setup.sending.resendKeyPlaceholder')" />
							<div v-if="sendingProvider === 'ses'" class="mt-2 space-y-2">
								<input v-model="sesRegion" :class="inputClass" :placeholder="t('desktop.setup.sending.sesRegionPlaceholder')" />
								<input v-model="sesAccessKey" :class="inputClass" :placeholder="t('desktop.setup.sending.sesAccessKeyPlaceholder')" />
								<input v-model="sesSecret" type="password" :class="inputClass" :placeholder="t('desktop.setup.sending.sesSecretPlaceholder')" />
							</div>
							<I18nT v-if="sendingProvider === 'mta'" keypath="desktop.setup.sending.mtaHint" tag="p" :class="hintClass" scope="global">
									<template #outbound><span class="font-mono">mail.</span></template>
									<template #returns><span class="font-mono">bounce.</span></template>
								</I18nT>
						</div>

						<div v-show="configStep === 'providers'" class="mt-5">
							<label :class="sectionClass">{{ t('desktop.setup.sections.ai') }}</label>
							<div class="relative">
								<select v-model="aiProvider" :class="[inputClass, 'appearance-none pr-8']">
									<option value="none">{{ t('common.none') }}</option>
										<option value="openrouter">{{ t('desktop.setup.ai.openrouter') }}</option>
										<option value="openai">{{ t('desktop.setup.ai.openai') }}</option>
										<option value="ollama">{{ t('desktop.setup.ai.ollama') }}</option>
								</select>
								<Icon name="lucide:chevron-down" class="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary" />
							</div>
							<input
								v-if="aiProvider === 'openrouter' || aiProvider === 'openai'"
								v-model="aiKey"
								:class="[inputClass, 'mt-2']"
								:placeholder="t('desktop.setup.ai.keyPlaceholder')"
							/>
						</div>

						<div v-show="configStep === 'admin'">
							<label :class="sectionClass">{{ t('desktop.setup.sections.admin') }}</label>
							<div class="space-y-2">
								<input v-model="adminEmail" :class="inputClass" placeholder="admin@example.com" />
								<input v-model="adminName" :class="inputClass" :placeholder="t('desktop.setup.admin.namePlaceholder')" />
								<div class="relative">
									<input
										v-model="adminPassword"
										:type="revealPassword ? 'text' : 'password'"
										:class="[inputClass, 'pr-10']"
										autocomplete="new-password"
										:placeholder="t('desktop.setup.admin.passwordPlaceholder')"
									/>
									<button
										type="button"
										class="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
										:aria-label="revealPassword ? t('desktop.setup.admin.hidePassword') : t('desktop.setup.admin.showPassword')"
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
									:placeholder="t('desktop.setup.admin.confirmPasswordPlaceholder')"
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
													? 'bg-success'
													: passwordAssessment.strength === 'fair'
														? 'bg-warning'
														: 'bg-error')
												: 'bg-border-default'"
										/>
									</div>
									<span
										class="w-20 shrink-0 text-right text-xs"
										:class="passwordAssessment.meetsMinLength ? 'text-text-secondary' : 'text-error'"
									>{{ tk(passwordAssessment.label) }}</span>
								</div>
								<p v-if="adminPasswordError" class="text-xs text-error">{{ tk(adminPasswordError) }}</p>
							</div>
						</div>

						<div v-show="configStep === 'domain'">
							<label :class="sectionClass">{{ isRemoteTarget ? t('desktop.setup.domain.labelRequired') : t('desktop.setup.domain.label') }}</label>
							<input v-model="domain" :class="inputClass" :placeholder="isRemoteTarget ? t('desktop.setup.domain.placeholderRequired') : t('desktop.setup.domain.placeholder')" />
							<p class="mt-1.5 text-xs text-text-secondary">
								{{ t('desktop.setup.domain.hint') }}
								<I18nT v-if="isRemoteTarget" keypath="desktop.setup.domain.hintRemote" scope="global">
									<template #localhost><span class="font-mono">localhost</span></template>
								</I18nT>
								<template v-else>
									{{ t('desktop.setup.domain.hintLocal') }}
								</template>
							</p>
							<p v-if="isRemoteTarget && !hasDomain" class="mt-1.5 text-xs text-warning">
								<Icon name="lucide:triangle-alert" class="mb-0.5 mr-1 inline size-3.5" />
								{{ t('desktop.setup.domain.noDomainWarning') }}
							</p>

							<!-- Connected by hostname → the SSH address is not an IP. The wizard
							     auto-detects the public IP over the SSH session; this field lets
							     the operator override it if detection failed or was wrong. -->
							<div v-if="hasDomain && !hostIsIp" class="mt-3">
								<label :class="labelClass">{{ t('desktop.setup.domain.publicIpLabel') }}</label>
								<input v-model="publicIp" :class="[inputClass, 'font-mono text-xs']" placeholder="203.0.113.5" inputmode="decimal" />
								<p class="mt-1 text-xs text-text-secondary">
									{{ t('desktop.setup.domain.publicIpHint') }}
								</p>
							</div>

							<div>
								<div v-if="hasDomain" class="mt-2">
									<DesktopHostnameOverrides
										v-model="hostLabels"
										:domain="domain"
										:errors="labelValidation.errors"
										:disabled-keys="disabledLabelKeys"
										:disabled-hint="t(HOST_LABEL_INACTIVE_HINT)"
									/>
								</div>

								<div class="mt-3 overflow-x-auto rounded-lg border border-border-subtle bg-bg-deep p-3">
									<p class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
										{{ t('desktop.setup.dns.createTitle') }}
									</p>
									<DesktopDnsRecordList v-if="dnsRecords.length" :records="displayDnsRecords" />
									<p v-else class="text-xs text-text-secondary">
										{{ t('desktop.setup.dns.enterDomain') }}
										<template v-if="isRemoteTarget"> {{ t('desktop.setup.dns.enterDomainRemote') }}</template>
										<template v-else> {{ t('desktop.setup.dns.enterDomainLocal') }}</template>
									</p>
									<p v-if="dnsRecords.length" class="mt-2 text-xs text-text-secondary">
										{{ t('desktop.setup.dns.tlsHint') }}
									</p>
									<p v-if="sendingProvider === 'mta' && dnsRecords.length" class="mt-1.5 text-xs text-warning">
										<Icon name="lucide:info" class="mb-0.5 mr-1 inline size-3.5" />
										<I18nT keypath="desktop.setup.dns.deliverabilityHint" scope="global">
											<template #settings><span class="font-medium">{{ t('desktop.setup.dns.settingsDomains') }}</span></template>
										</I18nT>
									</p>
								</div>
							</div>
						</div>

						<label v-show="configStep === 'admin'" class="mt-4 flex cursor-pointer items-center gap-2.5 text-sm">
							<input v-model="seedDemo" type="checkbox" class="peer sr-only" />
							<span
								class="flex size-4 shrink-0 items-center justify-center rounded border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-2"
								:class="seedDemo ? 'border-brand bg-brand' : 'border-border-default'"
							>
								<Icon v-if="seedDemo" name="lucide:check" class="size-3 text-text-inverse" />
							</span>
							<span>{{ t('desktop.setup.admin.seedDemo') }}</span>
						</label>

						<p v-if="configError" class="mt-4 text-sm text-error">{{ configError }}</p>
						<div class="mt-5 flex items-center gap-3 border-t border-border-subtle pt-4">
							<UiButton v-if="stepIndex > 0" variant="outline" size="sm" @click="prevStep">
									{{ t('common.back') }}
								</UiButton>
								<UiButton v-if="!isLastStep" size="sm" class="ml-auto" @click="nextStep">
									{{ t('common.next') }}
								</UiButton>
								<UiButton v-else type="submit" size="sm" class="ml-auto">
									{{ t('desktop.setup.provision') }}
								</UiButton>
						</div>
					</form>
				</section>

				<!-- ============ PROVISION / DONE / ERROR ============ -->
				<section v-else class="card">
					<DesktopProvisioningTimeline :steps="steps" :logs="logs" :progress="progress" />

					<!-- READY: the public URL is up and reachable -->
					<div v-if="stage === 'done' && canOpenWorkspace" class="mt-6 rounded-xl border border-success/30 bg-success/5 p-4">
						<p class="flex items-center gap-2 text-sm font-medium text-success">
							<Icon name="lucide:party-popper" class="size-4" /> {{ t('desktop.setup.done.readyTitle') }}
						</p>
						<p v-if="siteUrl" class="mt-1 text-xs text-text-secondary">{{ siteUrl }}</p>
						<UiButton class="mt-3" full-width @click="connectWorkspace">
								{{ t('desktop.setup.done.openWorkspace') }}
							</UiButton>
					</div>

					<!-- FINISHING UP: installed, but the public URL isn't answering yet (DNS/TLS) -->
					<div v-else-if="stage === 'done' && !siteIsLoopback" class="mt-6 rounded-xl border border-warning/40 bg-warning/5 p-4">
						<p class="flex items-center gap-2 text-sm font-medium text-warning">
							<Icon name="lucide:loader-circle" class="size-4" :class="{ 'animate-spin motion-reduce:animate-none': checkingReach }" />
							{{ t('desktop.setup.finishing.title') }}
							</p>
						<I18nT keypath="desktop.setup.finishing.body" tag="p" class="mt-1 text-xs text-text-secondary" scope="global">
								<template #url><span class="font-mono">{{ siteUrl }}</span></template>
							</I18nT>
						<div v-if="dnsRecords.length" class="mt-3 overflow-x-auto rounded-lg border border-border-subtle bg-bg-deep p-3">
							<p class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
									{{ t('desktop.setup.finishing.createRecords') }}
								</p>
							<DesktopDnsRecordList :records="displayDnsRecords" />
							<p class="mt-2 text-xs text-text-secondary">
									{{ t('desktop.setup.finishing.tlsHint') }}
								</p>
						</div>
						<UiButton variant="outline" size="sm" class="mt-3" :disabled="checkingReach" @click="recheckReachable">
							<template #iconLeft>
								<Icon name="lucide:refresh-cw" class="size-3.5" :class="{ 'animate-spin motion-reduce:animate-none': checkingReach }" />
							</template>
							{{ checkingReach ? t('desktop.setup.finishing.checking') : t('desktop.setup.finishing.checkAgain') }}
						</UiButton>
					</div>

					<!-- LOOPBACK: the URL only works on the server itself -->
					<div v-else-if="stage === 'done'" class="mt-6 rounded-xl border border-warning/40 bg-warning/5 p-4">
						<p class="flex items-center gap-2 text-sm font-medium text-warning">
							<Icon name="lucide:circle-check" class="size-4" /> {{ t('desktop.setup.loopback.title') }}
						</p>
						<I18nT keypath="desktop.setup.loopback.body" tag="p" class="mt-1 text-xs text-text-secondary" scope="global">
								<template #url><span class="font-mono">{{ siteUrl }}</span></template>
							</I18nT>
						<UiButton variant="outline" size="sm" class="mt-3" @click="retry">
								{{ t('desktop.setup.loopback.retry') }}
							</UiButton>
					</div>

					<!-- After any successful install: note the fate of the secrets-bearing config. -->
					<div v-if="stage === 'done'" class="mt-3 flex items-start gap-2 text-xs text-text-secondary">
						<Icon :name="secretsRemoved ? 'lucide:shield-check' : 'lucide:shield-alert'" class="mt-0.5 size-3.5 shrink-0" :class="secretsRemoved ? 'text-success' : 'text-warning'" />
						<span v-if="secretsRemoved">
							{{ t('desktop.setup.secrets.removed') }}
						</span>
						<I18nT v-else keypath="desktop.setup.secrets.notRemoved" tag="span" class="text-warning" scope="global">
							<template #file><span class="font-mono">.owlat-setup.json</span></template>
						</I18nT>
					</div>

					<div v-else-if="stage === 'error'" class="mt-6 rounded-xl border border-error/40 bg-error/5 p-4">
						<p class="text-sm font-medium text-error">{{ t('desktop.setup.failure.title') }}</p>
						<p class="mt-1 text-xs text-text-secondary">{{ error }}</p>
						<!-- The failing step's stderr tail, pinned so the root cause stays readable. -->
						<div v-if="failureTail.length" class="mt-2">
							<p class="mb-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">{{ t('desktop.setup.failure.lastOutput') }}</p>
							<pre class="max-h-40 overflow-auto rounded bg-bg-deep p-2 font-mono text-[11px] leading-snug text-error">{{ failureTail.join('\n') }}</pre>
						</div>
						<p class="mt-2 text-xs text-text-secondary">{{ t('desktop.setup.failure.hint') }}</p>
						<UiButton variant="outline" size="sm" class="mt-3" @click="retry">
								{{ t('desktop.setup.failure.retry') }}
							</UiButton>
					</div>
				</section>
			</template>
		</div>
	</div>
</template>
