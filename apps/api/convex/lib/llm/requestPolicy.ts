import { wrapLanguageModel, type LanguageModel } from 'ai';

/**
 * The options namespace an `@ai-sdk/openai-compatible` chat model reads: its
 * provider name (`openrouter`, `openai-compatible`), camel-cased. Undefined for
 * every other wire, including the native OpenAI and Azure SDK models.
 */
function compatibleChatOptionsKey(provider: string): string | undefined {
	const [name, api] = provider.split('.');
	if (api !== 'chat' || !name || name === 'openai' || name === 'azure') return undefined;
	return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** The instruction the AI SDK uses when a provider cannot take a JSON schema natively. */
function schemaInstruction(schema: unknown): string {
	return [
		'JSON schema:',
		JSON.stringify(schema),
		'You MUST answer with a JSON object that matches the JSON schema above.',
	].join('\n');
}

/**
 * Request rules the installed SDK does not apply on its own:
 *
 * - GPT-6 and Claude 5.5 reject non-default sampling; GPT-6 on the Responses
 *   API defaults to low reasoning. Detection reads the model id. On Azure the id
 *   is the deployment name, so only a deployment named after its model matches
 *   (see `azure.ts`).
 * - GPT-6 Luna's chat-completions tool calls need `reasoning_effort=none`, on
 *   any OpenAI-compatible chat wire (OpenRouter, or a custom endpoint).
 * - A chat model without native structured outputs sends a bare `json_object`
 *   request and drops the schema, so the schema goes into the system prompt.
 */
export function modelForRequest(model: LanguageModel): LanguageModel {
	if (typeof model !== 'object' || model.specificationVersion !== 'v3') return model;
	const id = model.modelId.replace(/^[^/]+\//, '');
	const gpt6 = /^gpt-6(?:[.-]|$)/.test(id);
	const claude55 = /^claude-(?:haiku|sonnet|opus)-5[.-]5(?:-|$)/.test(id);
	const chatOptionsKey = compatibleChatOptionsKey(model.provider);
	const isLunaOnChat = id === 'gpt-6-luna' && chatOptionsKey !== undefined;
	const needsSchemaInPrompt =
		'supportsStructuredOutputs' in model && model.supportsStructuredOutputs === false;
	if (!gpt6 && !claude55 && !needsSchemaInPrompt) return model;
	return wrapLanguageModel({
		model,
		middleware: {
			specificationVersion: 'v3',
			transformParams: async ({ params }) => {
				let next = params;
				const format = params.responseFormat;
				if (needsSchemaInPrompt && format?.type === 'json' && format.schema !== undefined) {
					const instruction = schemaInstruction(format.schema);
					const [first, ...rest] = params.prompt;
					const prompt: typeof params.prompt =
						first?.role === 'system'
							? [{ ...first, content: `${first.content}\n\n${instruction}` }, ...rest]
							: [{ role: 'system', content: instruction }, ...params.prompt];
					next = { ...next, prompt };
				}
				if (!gpt6 && !claude55) return next;
				const options = { ...params.providerOptions };
				if (gpt6 && /^(openai|azure)\.responses$/.test(model.provider)) {
					const key = model.provider.startsWith('azure') ? 'azure' : 'openai';
					// Low effort is the default; a caller's explicit effort wins.
					options[key] = { reasoningEffort: 'low', ...options[key], forceReasoning: true };
				}
				if (isLunaOnChat && chatOptionsKey) {
					options[chatOptionsKey] = { ...options[chatOptionsKey], reasoningEffort: 'none' };
				}
				return {
					...next,
					temperature: undefined,
					topP: undefined,
					topK: undefined,
					providerOptions: options,
				};
			},
		},
	});
}
