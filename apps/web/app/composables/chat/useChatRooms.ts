import { api } from '@owlat/api';

/**
 * Sidebar data for the chat dashboard: visible channels + DMs + unread state.
 *
 * Each item carries a synthesized `displayName`, `avatarSeed`, and per-room
 * unread metadata so the sidebar component stays purely presentational.
 */
export function useChatRooms() {
	const {
		data: channelsData,
		isLoading: channelsLoading,
		error: channelsError,
		refetch: refetchChannels,
	} = useConvexQuery(
		api.chat.rooms.listMyChannels,
		// Include archived so admins can reach an archived channel (and its
		// unarchive action); archived rows are split into their own group below.
		() => ({ includeArchived: true })
	);
	const {
		data: dmsData,
		isLoading: dmsLoading,
		error: dmsError,
		refetch: refetchDms,
	} = useConvexQuery(api.chat.dms.listMyDms, () => ({}));
	const { data: unreadData } = useConvexQuery(api.chat.messages.myUnreadCounts, () => ({}));

	const decoratedChannels = computed(() => {
		const list = channelsData.value ?? [];
		return list.map((c) => ({
			...c,
			displayName: c.name,
			avatarSeed: c.name,
			unread: unreadData.value?.[c._id.toString()] ?? {
				unreadCount: 0,
				hasMention: false,
			},
		}));
	});

	const channels = computed(() => decoratedChannels.value.filter((c) => !c.archivedAt));
	const archivedChannels = computed(() => decoratedChannels.value.filter((c) => c.archivedAt));

	const dms = computed(() => {
		const list = dmsData.value ?? [];
		return list.map((dm) => {
			const others = dm.otherParticipants ?? [];
			const displayName =
				others.length === 0
					? dm.name
					: others.length === 1
						? (others[0]?.name ?? others[0]?.email ?? dm.name)
						: dm.name;
			return {
				...dm,
				displayName,
				avatarSeed:
					others.length === 1 ? (others[0]?.email ?? others[0]?.memberId ?? dm.name) : dm.name,
				unread: unreadData.value?.[dm._id.toString()] ?? {
					unreadCount: 0,
					hasMention: false,
				},
			};
		});
	});

	const isLoading = computed(() => channelsLoading.value || dmsLoading.value);
	// A failed read is not an empty room list (#721).
	const error = computed(() => channelsError.value ?? dmsError.value);
	function refetch() {
		if (channelsError.value) refetchChannels();
		if (dmsError.value) refetchDms();
	}

	return { channels, archivedChannels, dms, isLoading, error, refetch };
}
