import { api } from '../../../convex/_generated/api';
import { effectRunner } from '$lib/runtime';
import { ConvexPrivateService } from '$lib/services/convex';
import { Effect } from 'effect';

export const load = async ({ params }) =>
	await effectRunner(
		Effect.gen(function* () {
			const convex = yield* ConvexPrivateService;
			const payload = yield* convex.query({
				func: api.private.proofs.getByToken,
				args: {
					token: params.token
				}
			});

			if (payload) {
				yield* convex.mutation({
					func: api.private.proofs.markVerified,
					args: {
						token: params.token
					}
				});
			}

			return {
				payload
			};
		})
	);
