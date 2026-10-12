/**
 * Azure OpenAI language adapter (`@ai-sdk/azure`).
 *
 * A native, hosted language provider on the LANGUAGE plane — GPT models served
 * from an Azure OpenAI resource. Unlike the plain `openai` adapter, Azure is
 * DEPLOYMENT-NAME based: the `modelId` a caller passes is the admin's own
 * deployment name (what they called the deployment in the Azure portal), not a
 * canonical OpenAI model id. `createAzure` maps that deployment name onto the
 * resource endpoint, so the two default ids below are only common conventions —
 * the effective id is always whatever the deployment is named.
 *
 * KNOWN LIMIT: Owlat stores no canonical model identity for a deployment. The
 * GPT-6 request handling (`lib/llm/requestPolicy.ts`) and list-price reporting
 * (`lib/llm/pricing.ts`) both read the model id, so they apply only to a
 * deployment named after its model (`gpt-6-luna`, or a name that starts with it,
 * such as `gpt-6-luna-eu`). A GPT-6 deployment named `mail-fast` gets neither:
 * sampling parameters are sent unchanged and spend is reported at the
 * unknown-model default. Hard-budget admission never prices Azure either way
 * (its endpoint provenance is `custom`). `lib/llm/__tests__/azureDeploymentIdentity.test.ts`
 * pins this.
 *
 * Config is a resource base URL (`https://<resource>.openai.azure.com/openai` —
 * the SDK appends `/v1` to it) plus an encrypted API key. The underlying client
 * is memoized per
 * `(baseUrl, key-fingerprint)` so repeated resolutions share one client; the
 * cache key never stores the raw key, only a non-reversible hash of it.
 *
 * Azure embeddings live on a separate deployment family; this adapter is
 * LANGUAGE-ONLY per the two-plane brief. Under an Azure language choice the
 * embedding plane still resolves independently (local-by-default).
 */

import { LANGUAGE_MODEL_CATALOG } from '@owlat/shared/aiModelCatalog';
import { createAzure } from '@ai-sdk/azure';
import type { LanguageModel } from 'ai';
import { hostedCacheKey, memoizeClient } from './clientCache';
import type { LanguageProviderAdapter, ProviderClientConfig } from './types';

type AzureClient = ReturnType<typeof createAzure>;

const clientCache = new Map<string, AzureClient>();

function azureClient(cfg: ProviderClientConfig): AzureClient {
	return memoizeClient(clientCache, hostedCacheKey(cfg), () =>
		createAzure({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl })
	);
}

export const azureLanguageAdapter: LanguageProviderAdapter<'azure'> = {
	kind: 'azure',
	label: 'Azure OpenAI',
	docsUrl: 'https://learn.microsoft.com/azure/ai-services/openai/',
	isLocal: false,
	// Deployment names, not canonical model ids — the admin sets these in Azure.
	// These are common conventions; the effective id is the deployment's name.
	defaultModels: LANGUAGE_MODEL_CATALOG.azure.defaults,
	buildChatModel(cfg: ProviderClientConfig, modelId: string): LanguageModel {
		return azureClient(cfg)(modelId);
	},
	validateCredentials(cfg: ProviderClientConfig): void {
		if (!cfg.apiKey) {
			throw new Error('Azure OpenAI requires an API key.');
		}
		if (!cfg.baseUrl) {
			throw new Error(
				'Azure OpenAI requires your resource base URL ' +
					'(e.g. https://<resource>.openai.azure.com/openai).'
			);
		}
	},
};
