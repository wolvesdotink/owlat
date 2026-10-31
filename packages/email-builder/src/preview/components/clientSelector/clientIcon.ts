import { Monitor, Smartphone, Tablet, Globe, Shield } from '@lucide/vue';

/** The icon component for a client, client family or device icon name. */
export function getIcon(iconName: string) {
	const icons: Record<string, unknown> = {
		monitor: Monitor,
		smartphone: Smartphone,
		tablet: Tablet,
		globe: Globe,
		shield: Shield,
		mail: Globe,
		'mail-open': Globe,
		apple: Monitor,
	};
	return icons[iconName] || Globe;
}
