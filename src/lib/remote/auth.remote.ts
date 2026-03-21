import { command } from '$app/server';
import { Effect } from 'effect';
import { effectRunner } from '$lib/runtime';
import { ClerkService } from '$lib/services/clerk';

export const createGuestSession = command(
	'unchecked',
	async () =>
		await effectRunner(
			Effect.gen(function* () {
				const clerk = yield* ClerkService;
				return yield* clerk.createDemoSignInTicket();
			})
		)
);
