/**
 * The desktop setup wizard's Connect step: the SSH address, user and
 * credentials, the install location, and the host-key confirmation. The page
 * holds it, so the entries survive the step being left and shown again.
 */
import type { Ref } from 'vue';
import {
	describeHostKey,
	isLoopbackHost,
	type ConnectInfo,
	type HostKeyPrompt,
} from '~/lib/desktop/provisioning';
import type { ServerCredentials } from '~/composables/useServerProvisioning';

export function useSetupConnectForm(options: {
	connectInfo: Readonly<Ref<ConnectInfo | null>>;
	connect: (input: ServerCredentials) => Promise<void>;
}) {
	const { connectInfo, connect } = options;
	const { t } = useI18n();

	const host = ref('');
	const port = ref('22');
	const username = ref('root');
	const authMethod = ref<'key' | 'password'>('key');
	const password = ref('');
	// Key auth: choose a key file in the native picker, or paste the key. The
	// path is display only: the native side reads the file the user picked, never
	// one this page names.
	const keySource = ref<'file' | 'paste'>('file');
	const keyPath = ref('');
	const privateKey = ref('');
	const passphrase = ref('');
	const installDir = ref('/opt/owlat');
	// The default install targets the newest published server release, resolved
	// on the server when provisioning starts (the same lookup install.sh does).
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
	// The development install (a branch instead of the release, or the local
	// checkout) is a hidden option: revealed in dev builds, with `?dev` on the
	// route, or by Alt/Shift-clicking the advanced toggle.
	const devOptionsRevealed = ref(isDev || 'dev' in useRoute().query);
	const devInstallChosen = ref(false);
	const devInstall = computed(() => devOptionsRevealed.value && devInstallChosen.value);
	const branch = ref('main');
	const connectError = ref('');

	function toggleAdvanced(event: MouseEvent) {
		if (event.altKey || event.shiftKey) devOptionsRevealed.value = true;
		showAdvanced.value = !showAdvanced.value;
	}

	/** Host-key prompt copy + whether a CHANGED key needs the extra confirmation. */
	const hostKeyPrompt = computed<HostKeyPrompt | null>(() =>
		connectInfo.value ? describeHostKey(connectInfo.value.knownHostStatus) : null
	);
	// A changed (mismatch) key must be explicitly acknowledged before "Accept".
	const mismatchAcknowledged = ref(false);
	watch(
		() => connectInfo.value?.fingerprint,
		() => {
			mismatchAcknowledged.value = false;
		}
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

	/** Native file picker for the key file (starts in ~/.ssh). */
	async function browseKeyFile() {
		try {
			const mod = await import('@owlat/desktop/src/ssh');
			const picked = await mod.sshPickKeyFile(t('desktop.setup.fields.chooseKeyFileTitle'));
			if (picked) keyPath.value = picked;
		} catch {
			// Not running inside Tauri.
		}
	}

	async function onConnect() {
		connectError.value = '';
		if (!host.value.trim()) return (connectError.value = t('desktop.setup.errors.hostRequired'));
		if (!username.value.trim())
			return (connectError.value = t('desktop.setup.errors.usernameRequired'));
		if (authMethod.value === 'password' && !password.value)
			return (connectError.value = t('desktop.setup.errors.passwordRequired'));
		if (authMethod.value === 'key' && keySource.value === 'file' && !keyPath.value)
			return (connectError.value = t('desktop.setup.errors.keyPathRequired'));
		if (authMethod.value === 'key' && keySource.value === 'paste' && !privateKey.value.trim())
			return (connectError.value = t('desktop.setup.errors.privateKeyRequired'));

		const auth =
			authMethod.value === 'key'
				? keySource.value === 'file'
					? ({
							type: 'key',
							usePickedKeyFile: true,
							passphrase: passphrase.value || undefined,
						} as const)
					: ({
							type: 'key',
							privateKey: privateKey.value,
							passphrase: passphrase.value || undefined,
						} as const)
				: ({ type: 'password', password: password.value } as const);

		await connect({
			host: host.value.trim(),
			port: Number(port.value) || 22,
			username: username.value.trim(),
			auth,
			remote: {
				installDir: installDir.value.trim() || '/opt/owlat',
				...(devInstall.value
					? {
							branch: branch.value.trim() || 'main',
							...(isDev && localSource.value.trim()
								? {
										localSource: normalizeLocalPath(localSource.value),
										localImages: imageMode.value === 'local',
									}
								: {}),
						}
					: {}),
			},
		});
	}

	const authOptions = computed(() => [
		{ value: 'key', label: t('desktop.setup.auth.key') },
		{ value: 'password', label: t('desktop.setup.auth.password') },
	]);

	return {
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
		isRemoteTarget,
		browseKeyFile,
		onConnect,
	};
}

export type SetupConnectForm = ReturnType<typeof useSetupConnectForm>;
