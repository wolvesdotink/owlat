/**
 * The real components the scenarios render, registered under the names Nuxt's
 * component auto-registration gives them (`ui/Avatar.vue` is `UiAvatar`,
 * `chat/ChatMessage.vue` stays `ChatMessage`), because their templates refer
 * to each other by those names.
 *
 * Only `Icon` is a stand-in: @nuxt/icon is a Nuxt module. Its CSS mode renders
 * one sized `<span>` per icon, and so does the stand-in, with the same classes.
 */
import { defineComponent, h, type App, type Component } from 'vue';

const modules = import.meta.glob<Component>(
	[
		'../../app/components/chat/{ChatMessage,ChatMessageList,ChatAttachmentChip}.vue',
		'../../app/components/assistant/{AssistantMessage,AssistantMarkdown,AssistantInline,AssistantToolCalls}.vue',
		'../../app/components/ai/BudgetRefusal.vue',
		'../../app/components/ui/Avatar.vue',
		'../../../../packages/ui/components/ui/Button.vue',
	],
	{ eager: true, import: 'default' }
);

/** Nuxt's name for a component file: its directories as a prefix, not repeated. */
function nuxtComponentName(path: string): string {
	const [, rest = ''] = path.split('/components/');
	const parts = rest.replace(/\.vue$/, '').split('/');
	const file = parts.pop() ?? '';
	const prefix = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
	return file.startsWith(prefix) ? file : `${prefix}${file}`;
}

const registry = new Map(
	Object.entries(modules).map(([path, component]) => [nuxtComponentName(path), component])
);

export function component(name: string): Component {
	const found = registry.get(name);
	if (!found) throw new Error(`component ${name} is not in the fixture registry`);
	return found;
}

const Icon = defineComponent({
	name: 'Icon',
	props: { name: { type: String, required: true } },
	setup(props) {
		return () => h('span', { class: 'iconify', 'data-icon': props.name, 'aria-hidden': 'true' });
	},
});

export function registerComponents(app: App): void {
	for (const [name, registered] of registry) app.component(name, registered);
	app.component('Icon', Icon);
}
