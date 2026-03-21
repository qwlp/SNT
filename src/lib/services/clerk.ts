import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { createClerkClient, type User } from '@clerk/backend';
import type { RequestEvent } from '@sveltejs/kit';
import { Data, Effect, Layer, ServiceMap } from 'effect';

export class ClerkError extends Data.TaggedError('ClerkError')<{
	readonly message: string;
	readonly kind: string;
	readonly traceId: string;
	readonly timestamp: number;
	readonly cause?: unknown;
}> {}

interface ClerkDef {
	validateAuth: (event: RequestEvent) => Effect.Effect<User, ClerkError>;
	createDemoSignInTicket: () => Effect.Effect<string, ClerkError>;
}

export class ClerkService extends ServiceMap.Service<ClerkService, ClerkDef>()('ClerkService') {
	static readonly layer = Layer.sync(ClerkService, () => {
		const clerk = createClerkClient({
			secretKey: privateEnv.CLERK_SECRET_KEY ?? '',
			publishableKey: publicEnv.PUBLIC_CLERK_PUBLISHABLE_KEY ?? ''
		});

		const getClerkCauseMessage = (cause: unknown, fallback: string) => {
			if (cause && typeof cause === 'object' && 'errors' in cause && Array.isArray(cause.errors)) {
				const details = cause.errors
					.map((error) => {
						if (!error || typeof error !== 'object') {
							return null;
						}

						const message =
							'longMessage' in error && typeof error.longMessage === 'string'
								? error.longMessage
								: 'message' in error && typeof error.message === 'string'
									? error.message
									: null;
						const code = 'code' in error && typeof error.code === 'string' ? error.code : null;

						if (!message && !code) {
							return null;
						}

						return code ? `${code}: ${message ?? 'Clerk request failed.'}` : message;
					})
					.filter((value): value is string => Boolean(value));

				if (details.length > 0) {
					return details.join(' | ');
				}
			}

			return cause instanceof Error ? cause.message : fallback;
		};

		const createClerkError = (kind: string, cause: unknown, fallback = 'Unknown error') =>
			new ClerkError({
				message: getClerkCauseMessage(cause, fallback),
				kind,
				traceId: crypto.randomUUID(),
				timestamp: Date.now(),
				cause
			});

		const validateAuth = (event: RequestEvent) =>
			Effect.gen(function* () {
				const { request } = event;

				const auth = yield* Effect.tryPromise({
					try: () => clerk.authenticateRequest(request).then((state) => state.toAuth()),
					catch: (e) => createClerkError('AuthenticationError', e)
				});

				if (!auth || !auth.isAuthenticated) {
					return yield* Effect.fail(
						new ClerkError({
							message: 'Unauthorized',
							kind: 'AuthenticationError',
							traceId: crypto.randomUUID(),
							timestamp: Date.now(),
							cause: new Error('Unauthorized')
						})
					);
				}

				const user = yield* Effect.tryPromise({
					try: () => clerk.users.getUser(auth.userId),
					catch: (e) => createClerkError('AuthenticationError', e)
				});

				return user;
			});

		const createDemoSignInTicket = () =>
			Effect.gen(function* () {
				const guestId = crypto.randomUUID();
				const user = yield* Effect.tryPromise({
					try: () =>
						clerk.users.createUser({
							firstName: 'Demo',
							lastName: 'Guest',
							emailAddress: [`demo+${guestId}@example.com`],
							skipPasswordRequirement: true,
							skipPasswordChecks: true,
							skipLegalChecks: true,
							unsafeMetadata: {
								demoGuest: true,
								guestId
							}
						}),
					catch: (error) =>
						createClerkError('DemoUserCreationError', error, 'Unable to create demo guest user.')
				});

				const signInToken = yield* Effect.tryPromise({
					try: () =>
						clerk.signInTokens.createSignInToken({
							userId: user.id,
							expiresInSeconds: 60
						}),
					catch: (error) =>
						createClerkError(
							'DemoTicketCreationError',
							error,
							'Unable to create demo guest sign-in ticket.'
						)
				});

				return signInToken.token;
			});

		return {
			validateAuth,
			createDemoSignInTicket
		};
	});
}
