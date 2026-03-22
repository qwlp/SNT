export type WeatherTone = 'clear' | 'watch' | 'rain' | 'storm';

export interface WeatherSnapshot {
	latitude: number;
	longitude: number;
	resolvedAt: number;
	temperatureC: number;
	apparentTemperatureC: number;
	precipitationMm: number;
	precipitationChancePercent: number;
	windSpeedKph: number;
	conditionCode: number;
	conditionLabel: string;
	isRainingNow: boolean;
	isStormingNow: boolean;
	willRainSoon: boolean;
	nextRainEtaHours: number | null;
	tone: WeatherTone;
	headline: string;
	detail: string;
	recommendation: string;
}
