import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * Top-level chat write actions that don't belong to a single room: create
 * channels, start DMs, browse public channels, link/unlink an inbox thread.
 */
export function useChatActions() {
	const { run: createChannelMutation } = useBackendOperation(
		api.chat.rooms.createChannel,
		{ label: 'Create channel' },
	);
	const { run: archiveChannelMutation } = useBackendOperation(
		api.chat.rooms.archiveChannel,
		{ label: 'Archive channel' },
	);
	const { run: unarchiveChannelMutation } = useBackendOperation(
		api.chat.rooms.unarchiveChannel,
		{ label: 'Unarchive channel' },
	);
	const { run: findOrCreateDmMutation } = useBackendOperation(
		api.chat.dms.findOrCreateDm,
		{ label: 'Start direct message' },
	);
	const { run: addMemberMutation } = useBackendOperation(
		api.chat.members.addMember,
		{ label: 'Add member' },
	);
	const { run: removeMemberMutation } = useBackendOperation(
		api.chat.members.removeMember,
		{ label: 'Remove member' },
	);
	const { run: setMemberRoleMutation } = useBackendOperation(
		api.chat.members.setMemberRole,
		{ label: 'Set member role' },
	);
	const { run: linkChannelMutation } = useBackendOperation(
		api.chat.emailLink.linkChannelToInboxThread,
		{ label: 'Link channel to inbox thread' },
	);
	const { run: unlinkChannelMutation } = useBackendOperation(
		api.chat.emailLink.unlinkChannel,
		{ label: 'Unlink channel' },
	);

	const createChannel = async (input: {
		name: string;
		description?: string;
		visibility: 'public' | 'private';
		initialMemberIds?: string[];
	}) => {
		return await createChannelMutation(input);
	};

	const archiveChannel = async (roomId: Id<'chatRooms'>) => {
		await archiveChannelMutation({ roomId });
	};
	const unarchiveChannel = async (roomId: Id<'chatRooms'>) => {
		await unarchiveChannelMutation({ roomId });
	};

	const findOrCreateDm = async (otherMemberIds: string[]) => {
		return await findOrCreateDmMutation({ otherMemberIds });
	};

	const addMember = async (
		roomId: Id<'chatRooms'>,
		memberId: string,
		role?: 'admin' | 'member',
	) => {
		await addMemberMutation({ roomId, memberId, role });
	};

	const removeMember = async (roomId: Id<'chatRooms'>, memberId: string) => {
		await removeMemberMutation({ roomId, memberId });
	};

	const setMemberRole = async (
		roomId: Id<'chatRooms'>,
		memberId: string,
		role: 'admin' | 'member',
	) => {
		await setMemberRoleMutation({ roomId, memberId, role });
	};

	// Return the run result so callers can branch on success — useBackendOperation
	// swallows throws and returns undefined on failure, so a try/catch around
	// these never fires.
	const linkChannelToInboxThread = async (
		roomId: Id<'chatRooms'>,
		inboxThreadId: Id<'conversationThreads'>,
	) => {
		return await linkChannelMutation({ roomId, inboxThreadId });
	};

	const unlinkChannel = async (roomId: Id<'chatRooms'>) => {
		return await unlinkChannelMutation({ roomId });
	};

	return {
		createChannel,
		archiveChannel,
		unarchiveChannel,
		findOrCreateDm,
		addMember,
		removeMember,
		setMemberRole,
		linkChannelToInboxThread,
		unlinkChannel,
	};
}

export function useChatPublicChannels() {
	const { data, isLoading } = useConvexQuery(
		api.chat.rooms.listPublicChannels,
		() => ({}),
	);
	const channels = computed(() => data.value ?? []);
	return { channels, isLoading };
}
