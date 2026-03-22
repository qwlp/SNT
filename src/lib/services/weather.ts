import { Effect } from 'effect';
import { createGenericError } from '$lib/runtime';
import type { WeatherSnapshot, WeatherTone } from '$lib/domain/weather';

interface OpenMeteoResponse {
	current: {
		temperature_2m: number;
		apparent_temperature: number;
		precipitation: number;
		rain: number;
		showers: number;
		weather_code: number;
		wind_speed_10m: number;
	};
	hourly: {
		time: string[];
		precipitation_probability: number[];
		precipitation: number[];
		rain: number[];
		showers: number[];
		weather_code: number[];
	};
}

const WEATHER_TIMEOUT_MS = 8_000;

const isRainCode = (code: number) =>
	[51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code);

const isStormCode = (code: number) => [95, 96, 99].includes(code);

const getConditionLabel = (code: number) => {
	switch (code) {
		case 0:
			return 'Clear sky';
		case 1:
		case 2:
			return 'Partly cloudy';
		case 3:
			return 'Overcast';
		case 45:
		case 48:
			return 'Fog';
		case 51:
		case 53:
		case 55:
		case 56:
		case 57:
			return 'Drizzle';
		case 61:
		case 63:
		case 65:
		case 66:
		case 67:
		case 80:
		case 81:
		case 82:
			return 'Rain';
		case 71:
		case 73:
		case 75:
		case 77:
		case 85:
		case 86:
			return 'Snow';
		case 95:
		case 96:
		case 99:
			return 'Thunderstorm';
		default:
			return 'Unsettled';
	}
};

const getNextRainEtaHours = (hourly: OpenMeteoResponse['hourly']) => {
	for (let index = 0; index < Math.min(hourly.time.length, 6); index += 1) {
		const precipitation = hourly.precipitation[index] ?? 0;
		const rain = hourly.rain[index] ?? 0;
		const showers = hourly.showers[index] ?? 0;
		const probability = hourly.precipitation_probability[index] ?? 0;
		const code = hourly.weather_code[index] ?? 0;

		if (
			precipitation >= 0.2 ||
			rain >= 0.2 ||
			showers >= 0.2 ||
			probability >= 45 ||
			isRainCode(code) ||
			isStormCode(code)
		) {
			return index;
		}
	}

	return null;
};

const buildNarrative = ({
	conditionLabel,
	isRainingNow,
	isStormingNow,
	willRainSoon,
	nextRainEtaHours
}: Pick<
	WeatherSnapshot,
	'conditionLabel' | 'isRainingNow' | 'isStormingNow' | 'willRainSoon' | 'nextRainEtaHours'
>): Pick<WeatherSnapshot, 'tone' | 'headline' | 'detail' | 'recommendation'> => {
	if (isStormingNow) {
		return {
			tone: 'storm',
			headline: 'Thunderstorm near you',
			detail: 'Expect reduced visibility and slick roads right now.',
			recommendation: 'Ride slower, avoid exposed roads, and report flooding if you see it.'
		};
	}

	if (isRainingNow) {
		return {
			tone: 'rain',
			headline: 'Rain is active now',
			detail: 'Road surfaces may already be slippery around your position.',
			recommendation: 'Give yourself extra braking distance and watch for pooled water.'
		};
	}

	if (willRainSoon) {
		return {
			tone: 'watch',
			headline:
				nextRainEtaHours === 0
					? 'Rain likely within the hour'
					: `Rain likely in about ${nextRainEtaHours} hour${nextRainEtaHours === 1 ? '' : 's'}`,
			detail: `${conditionLabel} now, but wet weather is building nearby.`,
			recommendation: 'Plan for slower travel and carry rain gear before heading out.'
		};
	}

	return {
		tone: 'clear',
		headline: 'No rain expected soon',
		detail: `${conditionLabel} around your current area.`,
		recommendation: 'Conditions look steady for now, but keep an eye on sudden road reports.'
	};
};

const validateCoordinate = (label: string, value: number, min: number, max: number) =>
	Number.isFinite(value) && value >= min && value <= max
		? Effect.succeed(value)
		: Effect.fail(
				createGenericError({
					message: `Invalid ${label} value.`,
					status: 400,
					kind: 'invalid_weather_coordinate'
				})
			);

export const getWeatherSnapshot = ({
	latitude,
	longitude
}: {
	latitude: number;
	longitude: number;
}) =>
	Effect.gen(function* () {
		yield* validateCoordinate('latitude', latitude, -90, 90);
		yield* validateCoordinate('longitude', longitude, -180, 180);

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);

		const url = new URL('https://api.open-meteo.com/v1/forecast');
		url.searchParams.set('latitude', latitude.toFixed(4));
		url.searchParams.set('longitude', longitude.toFixed(4));
		url.searchParams.set(
			'current',
			[
				'temperature_2m',
				'apparent_temperature',
				'precipitation',
				'rain',
				'showers',
				'weather_code',
				'wind_speed_10m'
			].join(',')
		);
		url.searchParams.set(
			'hourly',
			['precipitation_probability', 'precipitation', 'rain', 'showers', 'weather_code'].join(',')
		);
		url.searchParams.set('forecast_hours', '6');
		url.searchParams.set('timezone', 'auto');

		const payload = yield* Effect.tryPromise({
			try: async () => {
				const response = await fetch(url, {
					signal: controller.signal,
					headers: {
						Accept: 'application/json'
					}
				});

				if (!response.ok) {
					throw new Error(`Weather provider returned ${response.status}`);
				}

				return (await response.json()) as OpenMeteoResponse;
			},
			catch: (error) =>
				createGenericError({
					message: error instanceof Error ? error.message : 'Unable to fetch weather conditions.',
					status: 502,
					kind: 'weather_provider_failed',
					cause: error
				})
		}).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timeoutId))));

		const conditionCode = payload.current.weather_code ?? 0;
		const currentPrecipitation =
			(payload.current.precipitation ?? 0) +
			(payload.current.rain ?? 0) +
			(payload.current.showers ?? 0);
		const nextRainEtaHours = getNextRainEtaHours(payload.hourly);
		const willRainSoon = nextRainEtaHours !== null;
		const isStormingNow = isStormCode(conditionCode);
		const isRainingNow = isStormingNow || isRainCode(conditionCode) || currentPrecipitation >= 0.1;
		const precipitationChancePercent = payload.hourly.precipitation_probability[0] ?? 0;
		const conditionLabel = getConditionLabel(conditionCode);
		const narrative = buildNarrative({
			conditionLabel,
			isRainingNow,
			isStormingNow,
			willRainSoon,
			nextRainEtaHours
		});

		return {
			latitude,
			longitude,
			resolvedAt: Date.now(),
			temperatureC: payload.current.temperature_2m ?? 0,
			apparentTemperatureC: payload.current.apparent_temperature ?? 0,
			precipitationMm: currentPrecipitation,
			precipitationChancePercent,
			windSpeedKph: payload.current.wind_speed_10m ?? 0,
			conditionCode,
			conditionLabel,
			isRainingNow,
			isStormingNow,
			willRainSoon,
			nextRainEtaHours,
			tone: narrative.tone satisfies WeatherTone,
			headline: narrative.headline,
			detail: narrative.detail,
			recommendation: narrative.recommendation
		} satisfies WeatherSnapshot;
	});
