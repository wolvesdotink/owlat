<script setup lang="ts">
/**
 * The Connect step of the desktop setup wizard: where the server is, how to
 * sign in over SSH, where to install, and the host-key confirmation. The
 * entries live in the page's connect form, so they survive this step being
 * left and shown again.
 */
import type { ConnectInfo } from '~/lib/desktop/provisioning';
import type { ProvisionStage } from '~/composables/useServerProvisioning';
import type { SetupConnectForm } from '~/composables/desktopSetup/useSetupConnectForm';
import { labelClass } from '~/composables/desktopSetup/setupFormClasses';
import { useLocalized } from '~/composables/useLocalized';
import { ShieldWarningIcon } from '@coolicons/vue';

const props = defineProps<{
	form: SetupConnectForm;
	stage: ProvisionStage;
	busy: boolean;
	error: string | null;
	connectInfo: ConnectInfo | null;
}>();
const emit = defineEmits<{ acceptHostKey: [acceptChanged: boolean] }>();

const { t } = useI18n();
/** Host-key prompts arrive as a message key, optionally with interpolation params. */
const tk = useLocalized();

const {
	host,
	port,
	username,
	authMethod,
	authOptions,
	password,
	keySource,
	keyPath,
	privateKey,
	passphrase,
	installDir,
	isDev,
	localSource,
	imageMode,
	showAdvanced,
	devOptionsRevealed,
	devInstallChosen,
	devInstall,
	branch,
	connectError,
	toggleAdvanced,
	hostKeyPrompt,
	mismatchAcknowledged,
	browseKeyFile,
	onConnect,
} = props.form;
</script>

<template>
	<section class="card">
		<form class="space-y-4" @submit.prevent="onConnect">
			<div class="grid grid-cols-[1fr_5rem] gap-3">
				<div>
					<label class="mb-1 block text-xs font-medium text-text-secondary">{{
						t('desktop.setup.fields.host')
					}}</label>
					<input
						v-model="host"
						class="input input-sm"
						:placeholder="t('desktop.setup.fields.hostPlaceholder')"
						:disabled="busy"
					/>
				</div>
				<div>
					<label :class="labelClass">{{ t('desktop.setup.fields.port') }}</label>
					<input v-model="port" class="input input-sm" inputmode="numeric" :disabled="busy" />
				</div>
			</div>

			<div>
				<label :class="labelClass">{{ t('desktop.setup.fields.sshUser') }}</label>
				<input v-model="username" class="input input-sm" :disabled="busy" />
			</div>

			<div>
				<label :class="labelClass">{{ t('desktop.setup.fields.authentication') }}</label>
				<div
					class="mb-2 inline-block"
					role="group"
					:aria-label="t('desktop.setup.fields.authMethod')"
				>
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
							:value="keyPath"
							readonly
							class="input input-sm cursor-pointer"
							:class="{ 'font-mono': keyPath }"
							:placeholder="t('desktop.setup.fields.noKeyFile')"
							:aria-label="t('desktop.setup.fields.keyFile')"
							:disabled="busy"
							@click="browseKeyFile"
						/>
						<UiButton
							variant="outline"
							size="sm"
							class="shrink-0"
							:disabled="busy"
							@click="browseKeyFile"
						>
							{{ t('desktop.setup.fields.browse') }}
						</UiButton>
					</div>
					<textarea
						v-else
						v-model="privateKey"
						class="input input-sm h-28 resize-none font-mono"
						placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
						:disabled="busy"
					/>
					<button
						type="button"
						class="mt-1.5 text-xs text-text-secondary hover:text-text-primary"
						:disabled="busy"
						@click="keySource = keySource === 'file' ? 'paste' : 'file'"
					>
						{{
							keySource === 'file'
								? t('desktop.setup.fields.pasteKeyInstead')
								: t('desktop.setup.fields.useKeyFileInstead')
						}}
					</button>
					<input
						v-model="passphrase"
						type="password"
						class="input input-sm mt-2"
						:placeholder="t('desktop.setup.fields.passphrasePlaceholder')"
						:disabled="busy"
					/>
				</template>
				<input
					v-else
					v-model="password"
					type="password"
					class="input input-sm"
					:placeholder="t('desktop.setup.fields.sshPasswordPlaceholder')"
					:disabled="busy"
				/>
			</div>

			<button
				type="button"
				class="text-xs text-text-secondary hover:text-text-primary"
				@click="toggleAdvanced"
			>
				{{ showAdvanced ? t('desktop.setup.hideAdvanced') : t('desktop.setup.showAdvanced') }}
			</button>
			<div v-if="showAdvanced" class="space-y-3">
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label :class="labelClass">{{ t('desktop.setup.fields.installDir') }}</label>
						<input v-model="installDir" class="input input-sm" :disabled="busy" />
					</div>
					<div v-if="devInstall">
						<label :class="labelClass">{{ t('desktop.setup.fields.branch') }}</label>
						<input
							v-model="branch"
							class="input input-sm"
							:disabled="busy || !!localSource.trim()"
						/>
					</div>
					<div v-else>
						<label :class="labelClass">{{ t('desktop.setup.fields.version') }}</label>
						<input
							:value="t('desktop.setup.fields.versionLatest')"
							class="input input-sm"
							readonly
						/>
						<p class="mt-1.5 text-xs text-text-secondary">
							{{ t('desktop.setup.fields.versionHint') }}
						</p>
					</div>
				</div>
				<label v-if="devOptionsRevealed" class="flex cursor-pointer items-start gap-2.5 text-sm">
					<input v-model="devInstallChosen" type="checkbox" class="mt-0.5" :disabled="busy" />
					<span>
						{{ t('desktop.setup.fields.devInstall') }}
						<span class="block text-xs text-text-secondary">{{
							t('desktop.setup.fields.devInstallHint')
						}}</span>
					</span>
				</label>
				<div v-if="isDev && devInstall">
					<label :class="labelClass">{{ t('desktop.setup.fields.localSource') }}</label>
					<input
						v-model="localSource"
						class="input input-sm"
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
				:class="
					hostKeyPrompt.tone === 'danger'
						? 'border-error/40 bg-error/5'
						: 'border-warning/40 bg-warning/5'
				"
			>
				<p
					class="text-sm font-medium"
					:class="hostKeyPrompt.tone === 'danger' ? 'text-error' : 'text-warning'"
				>
					<ShieldWarningIcon class="mb-0.5 mr-1 inline size-4" />
					{{ tk(hostKeyPrompt.title) }}
				</p>
				<p class="mt-1 text-xs text-text-secondary">{{ tk(hostKeyPrompt.body) }}</p>
				<code
					class="mt-2 block break-all rounded bg-bg-deep px-2 py-1 font-mono text-xs text-text-primary"
					>{{ connectInfo?.fingerprint }}</code
				>

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
					@click="emit('acceptHostKey', hostKeyPrompt.isMismatch)"
				>
					{{
						hostKeyPrompt.isMismatch
							? t('desktop.setup.hostKey.acceptChanged')
							: t('desktop.setup.hostKey.accept')
					}}
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
</template>
