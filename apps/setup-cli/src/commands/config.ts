/**
 * `owlat-setup config` — re-open the wizard for an existing install.
 * Currently routes to `setup` with the existing .env preserved; future versions
 * can show a "what's missing" overview before launching.
 */

import { runSetup } from './setup';

export async function runConfig(opts: Parameters<typeof runSetup>[0]): Promise<number> {
	return await runSetup(opts);
}
