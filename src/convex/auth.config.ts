import type { AuthConfig } from 'convex/server';

const clerkIssuer = process.env.CLERK_JWT_ISSUER_DOMAIN!;

export default {
	providers: [
		{
			type: 'customJwt',
			issuer: clerkIssuer,
			jwks: `${clerkIssuer}/.well-known/jwks.json`,
			algorithm: 'RS256'
		}
	]
} satisfies AuthConfig;
