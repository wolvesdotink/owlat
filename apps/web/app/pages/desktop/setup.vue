<script setup lang="ts">
/**
 * Desktop "set up a new server" wizard. Reachable before any workspace exists
 * (see middleware/desktop-workspace.global.ts). Connects to a bare VPS over SSH,
 * collects configuration, then drives the installer with a live animated
 * timeline and finally connects the new instance as a workspace.
 */
import { isLoopbackUrl } from '~/lib/desktop/provisioning';
import { useSetupConnectForm } from '~/composables/desktopSetup/useSetupConnectForm';
import { useSetupConfigForm } from '~/composables/desktopSetup/useSetupConfigForm';
import { useSetupDnsRecords } from '~/composables/desktopSetup/useSetupDnsRecords';
import DesktopSetupConnectForm from '~/components/desktop/setup/ConnectForm.vue';
import DesktopSetupConfigureForm from '~/components/desktop/setup/ConfigureForm.vue';

const { t } = useI18n();

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
	leftoverConfigCleanup,
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
	void disconnect();
});

const connectForm = useSetupConnectForm({ connectInfo, connect });
const configForm = useSetupConfigForm({
	isRemoteTarget: connectForm.isRemoteTarget,
	detectedPublicIp,
	provision,
});
const { hostIsIp, dnsRecords, displayDnsRecords } = useSetupDnsRecords({
	host: connectForm.host,
	publicIp: configForm.publicIp,
	effectiveHosts: configForm.effectiveHosts,
	usesOwnMta: configForm.usesOwnMta,
});
const { isRemoteTarget } = connectForm;

const inConnect = computed(() =>
	['idle', 'connecting', 'hostkey', 'authenticating'].includes(stage.value)
);

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
					<NuxtLink
						to="/desktop/welcome"
						class="mb-4 inline-flex items-center gap-1 text-xs text-text-secondary transition-colors duration-(--motion-fast) hover:text-text-primary"
					>
						<Icon name="lucide:arrow-left" class="size-3.5" /> {{ t('common.back') }}
					</NuxtLink>
					<I18nT
						keypath="desktop.setup.heading"
						tag="h1"
						class="text-3xl font-medium tracking-[-0.02em] text-text-primary"
						scope="global"
					>
						<template #accent
							><span class="font-display italic">{{
								t('desktop.setup.headingAccent')
							}}</span></template
						>
					</I18nT>
					<p class="mt-2 text-md leading-[1.65] text-text-secondary">
						{{ t('desktop.setup.subtitle') }}
					</p>
				</header>

				<!-- ============ CONNECT ============ -->
				<DesktopSetupConnectForm
					v-if="inConnect"
					:form="connectForm"
					:stage="stage"
					:busy="busy"
					:error="error"
					:connect-info="connectInfo"
					@accept-host-key="acceptHostKey"
				/>

				<!-- ============ CONFIGURE ============ -->
				<DesktopSetupConfigureForm
					v-else-if="stage === 'configure'"
					:form="configForm"
					:is-remote-target="isRemoteTarget"
					:host-is-ip="hostIsIp"
					:dns-records="dnsRecords"
					:display-dns-records="displayDnsRecords"
				/>

				<!-- ============ PROVISION / DONE / ERROR ============ -->
				<section v-else class="card">
					<DesktopProvisioningTimeline :steps="steps" :logs="logs" :progress="progress" />

					<!-- READY: the public URL is up and reachable -->
					<div
						v-if="stage === 'done' && canOpenWorkspace"
						class="mt-6 rounded-xl border border-success/30 bg-success/5 p-4"
					>
						<p class="flex items-center gap-2 text-sm font-medium text-success">
							<Icon name="lucide:party-popper" class="size-4" />
							{{ t('desktop.setup.done.readyTitle') }}
						</p>
						<p v-if="siteUrl" class="mt-1 text-xs text-text-secondary">{{ siteUrl }}</p>
						<UiButton class="mt-3" full-width @click="connectWorkspace">
							{{ t('desktop.setup.done.openWorkspace') }}
						</UiButton>
					</div>

					<!-- FINISHING UP: installed, but the public URL isn't answering yet (DNS/TLS) -->
					<div
						v-else-if="stage === 'done' && !siteIsLoopback"
						class="mt-6 rounded-xl border border-warning/40 bg-warning/5 p-4"
					>
						<p class="flex items-center gap-2 text-sm font-medium text-warning">
							<Icon
								name="lucide:loader-circle"
								class="size-4"
								:class="{ 'animate-spin motion-reduce:animate-none': checkingReach }"
							/>
							{{ t('desktop.setup.finishing.title') }}
						</p>
						<I18nT
							keypath="desktop.setup.finishing.body"
							tag="p"
							class="mt-1 text-xs text-text-secondary"
							scope="global"
						>
							<template #url
								><span class="font-mono">{{ siteUrl }}</span></template
							>
						</I18nT>
						<div
							v-if="dnsRecords.length"
							class="mt-3 overflow-x-auto rounded-lg border border-border-subtle bg-bg-deep p-3"
						>
							<p class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
								{{ t('desktop.setup.finishing.createRecords') }}
							</p>
							<DesktopDnsRecordList :records="displayDnsRecords" />
							<p class="mt-2 text-xs text-text-secondary">
								{{ t('desktop.setup.finishing.tlsHint') }}
							</p>
						</div>
						<UiButton
							variant="outline"
							size="sm"
							class="mt-3"
							:disabled="checkingReach"
							@click="recheckReachable"
						>
							<template #iconLeft>
								<Icon
									name="lucide:refresh-cw"
									class="size-3.5"
									:class="{ 'animate-spin motion-reduce:animate-none': checkingReach }"
								/>
							</template>
							{{
								checkingReach
									? t('desktop.setup.finishing.checking')
									: t('desktop.setup.finishing.checkAgain')
							}}
						</UiButton>
					</div>

					<!-- LOOPBACK: the URL only works on the server itself -->
					<div
						v-else-if="stage === 'done'"
						class="mt-6 rounded-xl border border-warning/40 bg-warning/5 p-4"
					>
						<p class="flex items-center gap-2 text-sm font-medium text-warning">
							<Icon name="lucide:circle-check" class="size-4" />
							{{ t('desktop.setup.loopback.title') }}
						</p>
						<I18nT
							keypath="desktop.setup.loopback.body"
							tag="p"
							class="mt-1 text-xs text-text-secondary"
							scope="global"
						>
							<template #url
								><span class="font-mono">{{ siteUrl }}</span></template
							>
						</I18nT>
						<UiButton variant="outline" size="sm" class="mt-3" @click="retry">
							{{ t('desktop.setup.loopback.retry') }}
						</UiButton>
					</div>

					<!-- After any successful install: note the fate of the secrets-bearing config. -->
					<div
						v-if="stage === 'done'"
						class="mt-3 flex items-start gap-2 text-xs text-text-secondary"
					>
						<Icon
							:name="secretsRemoved ? 'lucide:shield-check' : 'lucide:shield-alert'"
							class="mt-0.5 size-3.5 shrink-0"
							:class="secretsRemoved ? 'text-success' : 'text-warning'"
						/>
						<span v-if="secretsRemoved">
							{{ t('desktop.setup.secrets.removed') }}
						</span>
						<I18nT
							v-else
							keypath="desktop.setup.secrets.notRemoved"
							tag="span"
							class="text-warning"
							scope="global"
						>
							<template #file><span class="font-mono">.owlat-setup.json</span></template>
						</I18nT>
					</div>

					<div
						v-else-if="stage === 'error'"
						class="mt-6 rounded-xl border border-error/40 bg-error/5 p-4"
					>
						<p class="text-sm font-medium text-error">{{ t('desktop.setup.failure.title') }}</p>
						<p class="mt-1 text-xs text-text-secondary">{{ error }}</p>
						<!-- The failing step's stderr tail, pinned so the root cause stays readable. -->
						<div v-if="failureTail.length" class="mt-2">
							<p class="mb-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
								{{ t('desktop.setup.failure.lastOutput') }}
							</p>
							<pre
								class="max-h-40 overflow-auto rounded bg-bg-deep p-2 font-mono text-[11px] leading-snug text-error"
								>{{ failureTail.join('\n') }}</pre>
						</div>
						<p class="mt-2 text-xs text-text-secondary">{{ t('desktop.setup.failure.hint') }}</p>
						<!-- The uploaded config (admin password, provider keys) could not be
						     removed after the failure: say so, with the exact command. -->
						<div v-if="leftoverConfigCleanup" class="mt-3 flex items-start gap-2 text-xs">
							<Icon name="lucide:shield-alert" class="mt-0.5 size-3.5 shrink-0 text-warning" />
							<I18nT
								keypath="desktop.setup.secrets.leftAfterFailure"
								tag="span"
								class="text-warning"
								scope="global"
							>
								<template #command>
									<code class="mt-1 block select-all font-mono">{{ leftoverConfigCleanup }}</code>
								</template>
							</I18nT>
						</div>
						<UiButton variant="outline" size="sm" class="mt-3" @click="retry">
							{{ t('desktop.setup.failure.retry') }}
						</UiButton>
					</div>
				</section>
			</template>
		</div>
	</div>
</template>
