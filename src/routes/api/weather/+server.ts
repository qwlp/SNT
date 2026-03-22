import { json } from '@sveltejs/kit';
import { Effect } from 'effect';
import { effectRunner } from '$lib/runtime';
import { getWeatherSnapshot } from '$lib/services/weather';

export const GET = async ({ url }) => {
	const latitude = Number(url.searchParams.get('lat'));
	const longitude = Number(url.searchParams.get('lng'));

	const response = await effectRunner(
		Effect.gen(function* () {
			return yield* getWeatherSnapshot({
				latitude,
				longitude
			});
		})
	);

	if (response instanceof Response) {
		return response;
	}

	return json(response, {
		headers: {
			'Cache-Control': 'public, max-age=300'
		}
	});
};
