import { ref, onMounted, type Ref } from 'vue';

export type DesktopPlatform = 'macos' | 'windows' | 'linux';

export const RELEASES_PAGE = 'https://github.com/wolvesdotink/owlat/releases';

/* Same endpoint the platform itself polls for update checks
 * (apps/api/convex/systemUpdates.ts). Unauthenticated + CORS-enabled. */
const LATEST_RELEASE_API = 'https://api.github.com/repos/wolvesdotink/owlat/releases/latest';

/* Installer patterns per platform — mirrors the release build matrix in
 * .github/workflows/_desktop-build.yml: macOS ships one universal .dmg
 * (Apple Silicon + Intel), Windows an NSIS -setup.exe and an .msi, Linux an
 * .AppImage and a .deb. Asset names embed the release version, so the exact
 * name is resolved from the release's real asset list at click time instead
 * of being constructed. Order = friendliest installer first. */
const ASSET_PATTERNS: Record<DesktopPlatform, RegExp[]> = {
	macos: [/\.dmg$/i],
	windows: [/-setup\.exe$/i, /\.msi$/i],
	linux: [/\.appimage$/i, /\.deb$/i],
};

const PLATFORM_LABELS: Record<DesktopPlatform, string> = {
	macos: 'macOS',
	windows: 'Windows',
	linux: 'Linux',
};

function detectPlatform(): DesktopPlatform | null {
	const ua = navigator.userAgent || '';
	const nav = navigator.platform || '';
	// iOS/iPadOS UAs contain "like Mac OS X" (and desktop-mode iPads report
	// "Macintosh") — there is no mobile build, so bail to the releases page.
	if (/iPhone|iPad|iPod/i.test(ua) || navigator.maxTouchPoints > 2) {
		if (!/win|linux/i.test(nav)) return null;
	}
	if (/mac/i.test(nav) || /Macintosh/i.test(ua)) return 'macos';
	if (/win/i.test(nav) || /Windows/i.test(ua)) return 'windows';
	if (/Android/i.test(ua)) return null;
	if (/linux/i.test(nav) || /Linux/i.test(ua)) return 'linux';
	return null;
}

async function resolveAssetUrl(platform: DesktopPlatform): Promise<string | null> {
	try {
		const res = await fetch(LATEST_RELEASE_API, {
			headers: { Accept: 'application/vnd.github+json' },
		});
		if (!res.ok) return null;
		const release = (await res.json()) as {
			assets?: { name: string; browser_download_url: string }[];
		};
		const assets = release.assets ?? [];
		for (const pattern of ASSET_PATTERNS[platform]) {
			const match = assets.find((asset) => pattern.test(asset.name));
			if (match) return match.browser_download_url;
		}
		return null; // latest release carries no desktop asset for this platform
	} catch {
		return null;
	}
}

export function useDesktopDownload(): {
	platform: Ref<DesktopPlatform | null>;
	platformLabel: Ref<string | null>;
	downloadAriaLabel: Ref<string>;
	onDownloadClick: (e: MouseEvent) => void;
} {
	const platform = ref<DesktopPlatform | null>(null);
	const platformLabel = ref<string | null>(null);
	const downloadAriaLabel = ref('Download the Owlat desktop app (releases page)');

	// SSG-safe: navigator only after mount, on the client.
	onMounted(() => {
		if (!import.meta.client) return;
		platform.value = detectPlatform();
		if (platform.value) {
			platformLabel.value = PLATFORM_LABELS[platform.value];
			downloadAriaLabel.value = `Download the Owlat desktop app for ${platformLabel.value}`;
		}
	});

	let resolved: Promise<string | null> | null = null;

	function onDownloadClick(e: MouseEvent) {
		// Modified/aux clicks (new tab, etc.) keep the releases-page href.
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
		const detected = platform.value;
		if (!detected) return; // unknown platform → follow the href
		e.preventDefault();
		resolved ??= resolveAssetUrl(detected);
		resolved.then((url) => {
			window.location.assign(url ?? RELEASES_PAGE);
		});
	}

	return { platform, platformLabel, downloadAriaLabel, onDownloadClick };
}
