export const ROUTING_MODES = ['car', 'scooter', 'bike', 'pedestrian', 'heavy_vehicle'] as const;

export const ROUTING_COST_PRIORITIES = [
	'balanced',
	'fastest',
	'lowest_tolls',
	'lowest_fuel'
] as const;

export type RoutingMode = (typeof ROUTING_MODES)[number];
export type RoutingCostPriority = (typeof ROUTING_COST_PRIORITIES)[number];

export interface RoutingPreferences {
	avoidHighways: boolean;
	avoidUTurns: boolean;
	preferWellLitStreets: boolean;
	preferFewerTurns: boolean;
	mode: RoutingMode;
	costPriority: RoutingCostPriority;
}

export const DEFAULT_ROUTING_PREFERENCES: RoutingPreferences = {
	avoidHighways: false,
	avoidUTurns: true,
	preferWellLitStreets: true,
	preferFewerTurns: false,
	mode: 'scooter',
	costPriority: 'balanced'
};

export const normalizeRoutingPreferences = (
	value: Partial<RoutingPreferences> | null | undefined
): RoutingPreferences => ({
	...DEFAULT_ROUTING_PREFERENCES,
	...(value ?? {})
});
