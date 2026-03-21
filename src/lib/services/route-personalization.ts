import type { RoutingPreferences } from '$lib/domain/routing';

export interface RouteStepInput {
	distanceMeters: number;
	roadName?: string;
	maneuverType?: string;
	maneuverModifier?: string;
}

export interface RouteMetrics {
	turnCount: number;
	uTurnCount: number;
	highwayDistanceMeters: number;
	litRoadDistanceMeters: number;
	shortcutDistanceMeters: number;
	mainRoadDistanceMeters: number;
}

export interface RouteCostEstimate {
	estimatedTollCostUsd: number;
	estimatedFuelLiters: number;
}

const HIGHWAY_PATTERN =
	/\b(hwy|highway|expressway|motorway|freeway|ring road|beltway|nr ?\d+|national road|ah\d+)\b/i;
const MAIN_ROAD_PATTERN =
	/\b(blvd|boulevard|avenue|ave|st|street|road|rd|way|bridge|bridge road)\b/i;
const SHORTCUT_PATTERN = /\b(alley|lane|ln|shortcut|service road|market road)\b/i;

const getFuelLitersPer100Km = (mode: RoutingPreferences['mode']) => {
	switch (mode) {
		case 'scooter':
			return 2.4;
		case 'bike':
		case 'pedestrian':
			return 0;
		case 'heavy_vehicle':
			return 24;
		case 'car':
		default:
			return 7.8;
	}
};

const isNight = (timestamp: number) => {
	const hour = new Date(timestamp).getHours();
	return hour >= 18 || hour < 5;
};

export const estimateRouteCosts = ({
	distanceMeters,
	highwayDistanceMeters,
	mode
}: {
	distanceMeters: number;
	highwayDistanceMeters: number;
	mode: RoutingPreferences['mode'];
}): RouteCostEstimate => {
	const distanceKm = distanceMeters / 1000;
	const highwayShare = distanceMeters > 0 ? highwayDistanceMeters / distanceMeters : 0;
	const estimatedFuelLiters = Number(((distanceKm * getFuelLitersPer100Km(mode)) / 100).toFixed(2));
	const estimatedTollCostUsd = Number((highwayShare * distanceKm * 0.18).toFixed(2));

	return {
		estimatedFuelLiters,
		estimatedTollCostUsd
	};
};

export const analyzeRouteMetrics = (
	steps: RouteStepInput[],
	distanceMeters: number
): RouteMetrics => {
	let turnCount = 0;
	let uTurnCount = 0;
	let highwayDistanceMeters = 0;
	let litRoadDistanceMeters = 0;
	let shortcutDistanceMeters = 0;
	let mainRoadDistanceMeters = 0;

	for (const step of steps) {
		const name = step.roadName?.trim() ?? '';
		const distance = Math.max(0, step.distanceMeters);
		const maneuverType = step.maneuverType?.toLowerCase();
		const maneuverModifier = step.maneuverModifier?.toLowerCase();

		if (
			maneuverType &&
			maneuverType !== 'depart' &&
			maneuverType !== 'arrive' &&
			maneuverType !== 'notification'
		) {
			turnCount += 1;
		}

		if (maneuverModifier === 'uturn' || maneuverType === 'uturn') {
			uTurnCount += 1;
		}

		if (HIGHWAY_PATTERN.test(name)) {
			highwayDistanceMeters += distance;
			litRoadDistanceMeters += distance;
			mainRoadDistanceMeters += distance;
			continue;
		}

		if (SHORTCUT_PATTERN.test(name)) {
			shortcutDistanceMeters += distance;
			continue;
		}

		if (MAIN_ROAD_PATTERN.test(name)) {
			mainRoadDistanceMeters += distance;
			litRoadDistanceMeters += distance;
		}
	}

	if (steps.length === 0) {
		mainRoadDistanceMeters = distanceMeters * 0.4;
		litRoadDistanceMeters = distanceMeters * 0.35;
	}

	return {
		turnCount,
		uTurnCount,
		highwayDistanceMeters,
		litRoadDistanceMeters,
		shortcutDistanceMeters,
		mainRoadDistanceMeters
	};
};

export const applyRoutingPreferences = ({
	baseDurationSec,
	distanceMeters,
	incidentPenalty,
	shortcutBonus,
	shortcutCount,
	metrics,
	preferences,
	generatedAt
}: {
	baseDurationSec: number;
	distanceMeters: number;
	incidentPenalty: number;
	shortcutBonus: number;
	shortcutCount: number;
	metrics: RouteMetrics;
	preferences: RoutingPreferences;
	generatedAt: number;
}) => {
	const costs = estimateRouteCosts({
		distanceMeters,
		highwayDistanceMeters: metrics.highwayDistanceMeters,
		mode: preferences.mode
	});
	const chips = new Set<string>();
	let score = baseDurationSec + incidentPenalty - shortcutBonus;
	const highwayShare = distanceMeters > 0 ? metrics.highwayDistanceMeters / distanceMeters : 0;
	const litShare = distanceMeters > 0 ? metrics.litRoadDistanceMeters / distanceMeters : 0;

	if (preferences.avoidHighways) {
		score += highwayShare * 750;
		if (highwayShare < 0.12) {
			chips.add('Low highway exposure');
		}
	}

	if (preferences.avoidUTurns) {
		score += metrics.uTurnCount * 280;
		if (metrics.uTurnCount === 0) {
			chips.add('No U-turns');
		}
	}

	if (preferences.preferFewerTurns) {
		score += metrics.turnCount * 28;
		if (metrics.turnCount <= 4) {
			chips.add('Fewer turns');
		}
	}

	if (preferences.preferWellLitStreets && isNight(generatedAt)) {
		score += Math.max(0, 0.65 - litShare) * 420;
		if (litShare >= 0.55) {
			chips.add('Leans toward lit main roads');
		}
	}

	switch (preferences.mode) {
		case 'scooter':
			score += highwayShare * 210;
			if (shortcutCount > 0) {
				chips.add('Scooter-friendly shortcut access');
			}
			break;
		case 'bike':
			score += highwayShare * 420 + metrics.uTurnCount * 80;
			chips.add('Bike profile');
			break;
		case 'pedestrian':
			score += highwayShare * 720 + metrics.uTurnCount * 120;
			chips.add('Pedestrian profile');
			break;
		case 'heavy_vehicle':
			score += metrics.turnCount * 42 + metrics.uTurnCount * 360 + shortcutCount * 220;
			chips.add('Heavy vehicle preset');
			break;
		case 'car':
		default:
			break;
	}

	switch (preferences.costPriority) {
		case 'fastest':
			chips.add('Time-first');
			break;
		case 'lowest_tolls':
			score += costs.estimatedTollCostUsd * 190;
			chips.add('Lower toll estimate');
			break;
		case 'lowest_fuel':
			score += costs.estimatedFuelLiters * 140;
			chips.add('Lower fuel estimate');
			break;
		case 'balanced':
		default:
			score += costs.estimatedTollCostUsd * 85 + costs.estimatedFuelLiters * 65;
			chips.add('Balanced cost');
			break;
	}

	return {
		adjustedScore: score,
		personalizationChips: [...chips],
		...costs
	};
};
