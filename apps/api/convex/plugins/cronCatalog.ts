import { BUNDLED_PLUGIN_CRON_CATALOG } from './cronCatalog.generated';
import {
	defineHostedContributionCatalog,
	type HostedContributionDefinition,
} from './hostedContributionCatalog';

export interface HostedCronDefinition extends HostedContributionDefinition<'scheduler:cron'> {
	readonly label: string;
	readonly intervalMinutes: number;
	readonly timeoutMs: number;
	readonly requiredEnvVars: readonly string[];
}

const CATALOG = defineHostedContributionCatalog<HostedCronDefinition>(
	BUNDLED_PLUGIN_CRON_CATALOG,
	'cron'
);

export const CRON_CATALOG = CATALOG.all;

export function pluginCronDefinition(kind: string): HostedCronDefinition | undefined {
	return CATALOG.byKind(kind);
}
