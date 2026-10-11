import { wrapLanguageModel, type LanguageModel } from 'ai';

/**
 * The installed SDK predates GPT-6 and Claude 5.5 capability detection, so this
 * applies their request rules by model id. On Azure the id is the deployment
 * name: only a deployment named after its model is matched (see `azure.ts`).
 */
export function modelForRequest(model: LanguageModel): LanguageModel {
	if (typeof model !== 'object' || model.specificationVersion !== 'v3') return model;
	const id = model.modelId.replace(/^[^/]+\//, '');
	const gpt6 = /^gpt-6(?:[.-]|$)/.test(id);
	const claude55 = /^claude-(?:haiku|sonnet|opus)-5[.-]5(?:-|$)/.test(id);
	if (!gpt6 && !claude55) return model;
	return wrapLanguageModel({
		model,
		middleware: {
			specificationVersion: 'v3',
			transformParams: async ({ params }) => {
				const options = { ...params.providerOptions };
				if (gpt6 && /^(openai|azure)\.responses$/.test(model.provider)) {
					const key = model.provider.startsWith('azure') ? 'azure' : 'openai';
					// Low effort is the default; a caller's explicit effort wins.
					options[key] = { reasoningEffort: 'low', ...options[key], forceReasoning: true };
				}
				if (id === 'gpt-6-luna' && model.provider === 'openrouter.chat') {
					// Luna's chat-completions tool calls require reasoning_effort=none.
					options['openrouter'] = { ...options['openrouter'], reasoningEffort: 'none' };
				}
				return {
					...params,
					temperature: undefined,
					topP: undefined,
					topK: undefined,
					providerOptions: options,
				};
			},
		},
	});
}
