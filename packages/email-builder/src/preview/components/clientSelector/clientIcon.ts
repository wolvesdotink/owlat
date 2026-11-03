import { GlobeIcon, MobileIcon, MonitorIcon, ShieldIcon, TabletIcon } from '@coolicons/vue';

/** The icon component for a client, client family or device icon name. */
export function getIcon(iconName: string) {
	const icons: Record<string, unknown> = {
		monitor: MonitorIcon,
		smartphone: MobileIcon,
		tablet: TabletIcon,
		globe: GlobeIcon,
		shield: ShieldIcon,
		mail: GlobeIcon,
		'mail-open': GlobeIcon,
		apple: MonitorIcon,
	};
	return icons[iconName] || GlobeIcon;
}
