import { BUNDLED_PLUGIN_CRON_CATALOG } from './cronCatalog.generated';

export interface HostedCronDefinition {
	readonly kind: string;
	readonly pluginId: string;
	readonly label: string;
	readonly intervalMinutes: number;
	readonly timeoutMs: number;
	readonly requiredEnvVars: readonly string[];
	readonly requiredCapability: 'scheduler:cron';
}

export const CRON_CATALOG = BUNDLED_PLUGIN_CRON_CATALOG as readonly HostedCronDefinition[];

export function pluginCronDefinition(kind: string): HostedCronDefinition | undefined {
	return CRON_CATALOG.find((definition) => definition.kind === kind);
}
