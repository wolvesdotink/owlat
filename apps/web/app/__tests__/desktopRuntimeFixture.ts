/**
 * Run a suite's next mount as the desktop app: the Tauri global the runtime
 * check reads, and a connected instance as the active workspace. A suite that
 * opens a page in the system browser also mocks `@owlat/desktop/src/shell`
 * itself (`vi.mock` is hoisted per file).
 */
import { onTestFinished } from 'vitest';
import { setActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import type { WorkspaceConfig } from '~/lib/desktop/workspaceTypes';

/** The connected instance's web origin. */
export const DESKTOP_SITE_URL = 'https://owlat.example.com';

export function onDesktop(siteUrl: string | null = DESKTOP_SITE_URL): void {
	const tauri = window as unknown as Record<string, unknown>;
	tauri['__TAURI_INTERNALS__'] = {};
	setActiveWorkspace(siteUrl === null ? null : ({ id: 'ws-1', siteUrl } as WorkspaceConfig));
	onTestFinished(() => {
		delete tauri['__TAURI_INTERNALS__'];
		setActiveWorkspace(null);
	});
}
