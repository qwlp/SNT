<script lang="ts">
	import { env } from '$env/dynamic/public';
	import { CONVEX_URL } from '$lib/convex-env';
	import { getClerkContext } from '$lib/stores/clerk.svelte';
	import { setupConvex, useConvexClient } from 'convex-svelte';

	const clerkContext = getClerkContext();
	const clerkJwtTemplate = env.PUBLIC_CLERK_JWT_TEMPLATE || 'convex';
	let didWarnAboutMissingJwtTemplate = false;
	let didWarnAboutMissingSessionToken = false;

	const getClerkAuthToken = async () => {
		if (!clerkContext.currentSession) return null;

		try {
			return await clerkContext.currentSession.getToken({
				template: clerkJwtTemplate
			});
		} catch (error) {
			if (!didWarnAboutMissingJwtTemplate) {
				didWarnAboutMissingJwtTemplate = true;
				console.error(
					`Unable to fetch Clerk JWT template "${clerkJwtTemplate}" for Convex. ` +
						'Create that JWT template in the Clerk dashboard or set PUBLIC_CLERK_JWT_TEMPLATE to the correct template name.',
					error
				);
			}

			try {
				const sessionToken = await clerkContext.currentSession.getToken();

				if (!sessionToken && !didWarnAboutMissingSessionToken) {
					didWarnAboutMissingSessionToken = true;
					console.error('Clerk did not return a default session token for Convex authentication.');
				}

				return sessionToken;
			} catch (sessionTokenError) {
				if (!didWarnAboutMissingSessionToken) {
					didWarnAboutMissingSessionToken = true;
					console.error(
						'Unable to fetch a default Clerk session token for Convex.',
						sessionTokenError
					);
				}

				return null;
			}
		}
	};

	setupConvex(CONVEX_URL ?? '');

	const convex = useConvexClient();

	convex.setAuth(getClerkAuthToken);

	const { children } = $props();
</script>

{@render children()}
