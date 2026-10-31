import { describe, expect, it } from 'vitest';
import { desktopAssetUrl } from '../useDesktopDownload';

const asset = (name: string) => ({
	name,
	browser_download_url: `https://github.com/wolvesdotink/owlat/releases/download/v1.2.3/${name}`,
});

describe('desktopAssetUrl', () => {
	const release = {
		tag_name: 'v1.2.3',
		assets: [asset('Owlat_1.2.3_x64.msi'), asset('Owlat_1.2.3_x64-setup.exe'), asset('Owlat.dmg')],
	};

	it('picks the friendliest installer the release lists for the platform', () => {
		expect(desktopAssetUrl(release, 'windows')).toBe(
			asset('Owlat_1.2.3_x64-setup.exe').browser_download_url
		);
		expect(desktopAssetUrl(release, 'macos')).toBe(asset('Owlat.dmg').browser_download_url);
		expect(desktopAssetUrl(release, 'linux')).toBeNull();
	});

	it.each([
		['null', null],
		['a list', [asset('Owlat.dmg')]],
		['no assets', {}],
		['assets that are not a list', { assets: { 0: asset('Owlat.dmg') } }],
	])('finds nothing in an answer with %s', (_name, answer) => {
		expect(desktopAssetUrl(answer, 'macos')).toBeNull();
	});

	it('skips assets of the wrong shape and keeps looking', () => {
		const answer = {
			assets: [
				null,
				'Owlat.dmg',
				{ name: 42, browser_download_url: asset('Owlat.dmg').browser_download_url },
				{ name: 'Owlat.dmg' },
				{ name: 'Owlat.dmg', browser_download_url: 'javascript:alert(1)' },
				asset('Owlat-universal.dmg'),
			],
		};
		expect(desktopAssetUrl(answer, 'macos')).toBe(
			asset('Owlat-universal.dmg').browser_download_url
		);
	});
});
