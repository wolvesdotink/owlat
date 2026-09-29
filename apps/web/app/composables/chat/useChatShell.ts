import { inject, provide, type InjectionKey, type Ref } from 'vue';

/**
 * What the chat parent route (`pages/dashboard/chat.vue`) lends its child
 * pages. The parent owns the rail and the shared dialogs; a child only needs
 * to open them: the mobile drawer handle opens the rail, and the empty state's
 * buttons open the channel browser and the new-channel dialog.
 */
export interface ChatShell {
	/** Whether the off-canvas rail (below md) is open, for the handle's aria-expanded. */
	railOpen: Readonly<Ref<boolean>>;
	openRail: () => void;
	openCreateChannel: () => void;
	openBrowseChannels: () => void;
}

const CHAT_SHELL_KEY: InjectionKey<ChatShell> = Symbol('chatShell');

/** Called once by the chat parent route. */
export function provideChatShell(shell: ChatShell): void {
	provide(CHAT_SHELL_KEY, shell);
}

/** The chat shell of the enclosing `pages/dashboard/chat.vue`. */
export function useChatShell(): ChatShell {
	const shell = inject(CHAT_SHELL_KEY, null);
	if (!shell) {
		throw new Error(
			'useChatShell() needs the chat parent route: render this page under pages/dashboard/chat.vue.'
		);
	}
	return shell;
}
