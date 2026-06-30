const timestamp = Date.now();

export const TEST_USER = {
	name: 'E2E Test User',
	email: `e2e-test-${timestamp}@example.com`,
	password: 'TestPassword123!',
	teamName: "E2E Test User's Team",
};

export const SAMPLE_CONTACTS = [
	{ email: `contact1-${timestamp}@example.com`, firstName: 'Alice', lastName: 'Smith' },
	{ email: `contact2-${timestamp}@example.com`, firstName: 'Bob', lastName: 'Jones' },
	{ email: `contact3-${timestamp}@example.com`, firstName: 'Carol', lastName: 'Williams' },
];
