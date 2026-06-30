/**
 * Capitalizes the first letter of a string
 */
export function capitalize(str: string): string {
	if (!str) return str;
	return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Extracts initials from a name
 * @param name - The name to extract initials from
 * @param maxLength - Maximum number of initials to return (defaults to 2)
 */
export function initials(name: string, maxLength: number = 2): string {
	if (!name) return '';
	return name
		.split(/\s+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase())
		.slice(0, maxLength)
		.join('');
}

/**
 * Truncates a string to a maximum length with an optional suffix
 * @param str - The string to truncate
 * @param maxLength - Maximum length of the result including suffix
 * @param suffix - The suffix to append when truncated (defaults to '...')
 */
export function truncate(
	str: string,
	maxLength: number,
	suffix: string = '...'
): string {
	if (!str || str.length <= maxLength) return str;
	const truncatedLength = maxLength - suffix.length;
	if (truncatedLength <= 0) return suffix.slice(0, maxLength);
	return str.slice(0, truncatedLength) + suffix;
}
