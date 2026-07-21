const STATIC_EXPORT_PATH = /^\.\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_STATIC_EXPORT_PATH_LENGTH = 256;

/** True only for a bounded, statically importable relative package export. */
export function isSafeStaticExportPath(value: string): boolean {
	return (
		value.length <= MAX_STATIC_EXPORT_PATH_LENGTH &&
		STATIC_EXPORT_PATH.test(value) &&
		!value.endsWith('/') &&
		!value.includes('//') &&
		!value
			.slice(2)
			.split('/')
			.some((segment) => segment === '.' || segment === '..')
	);
}
