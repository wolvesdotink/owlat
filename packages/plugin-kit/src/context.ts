import type { JsonObject, JsonValue } from './json';
import type { PluginPermissionService } from './capabilities';

export type PluginLogFields = Readonly<Record<string, JsonValue>>;

export interface PluginLogger {
	debug(message: string, fields?: PluginLogFields): void;
	info(message: string, fields?: PluginLogFields): void;
	warn(message: string, fields?: PluginLogFields): void;
	error(message: string, fields?: PluginLogFields): void;
}

export interface PluginStorageListOptions {
	readonly prefix?: string;
	readonly limit?: number;
	readonly cursor?: string;
}

export interface PluginStorageListResult {
	readonly keys: readonly string[];
	readonly cursor?: string;
}

export interface PluginStorageService {
	get(key: string): Promise<JsonValue | undefined>;
	set(key: string, value: JsonValue): Promise<void>;
	delete(key: string): Promise<void>;
	list(options?: PluginStorageListOptions): Promise<PluginStorageListResult>;
}

export type PluginLlmTier = 'fast' | 'capable';

export interface PluginLlmMessage {
	readonly role: 'assistant' | 'system' | 'user';
	readonly content: string;
}

export type PluginLlmGenerateRequest =
	| {
			readonly tier: PluginLlmTier;
			readonly messages: readonly PluginLlmMessage[];
			readonly system?: never;
			readonly prompt?: never;
	  }
	| {
			readonly tier: PluginLlmTier;
			readonly prompt: string;
			readonly system?: string;
			readonly messages?: never;
	  };

export interface PluginLlmUsage {
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly totalTokens: number;
}

export interface PluginLlmGenerateResult {
	readonly text: string;
	readonly modelUsed?: string;
	readonly usage?: PluginLlmUsage;
}

export interface PluginLlmService {
	generate(request: PluginLlmGenerateRequest): Promise<PluginLlmGenerateResult>;
}

export interface PluginScheduledTask {
	readonly name: string;
	readonly payload?: JsonObject;
}

export interface PluginSchedulerService {
	runAfter(delayMs: number, task: PluginScheduledTask): Promise<void>;
}

/** Services supplied by the host. Plugins never receive a raw Convex context. */
export interface PluginContext {
	readonly pluginId: string;
	readonly permissions: PluginPermissionService;
	readonly storage: PluginStorageService;
	readonly llm: PluginLlmService;
	readonly logger: PluginLogger;
	readonly scheduler: PluginSchedulerService;
}
