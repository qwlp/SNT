export const ROUTING_MODES = [
	'gas_car',
	'diesel_car',
	'electric_car',
	'scooter',
	'bike',
	'pedestrian',
	'heavy_vehicle'
] as const;
export const LEGACY_ROUTING_MODES = ['car'] as const;

export const ROUTING_COST_PRIORITIES = [
	'balanced',
	'fastest',
	'lowest_tolls',
	'lowest_fuel'
] as const;

export type SelectableRoutingMode = (typeof ROUTING_MODES)[number];
export type LegacyRoutingMode = (typeof LEGACY_ROUTING_MODES)[number];
export type RoutingMode = SelectableRoutingMode | LegacyRoutingMode;
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

export const normalizeRoutingMode = (
	mode: RoutingMode | null | undefined
): SelectableRoutingMode => {
	switch (mode) {
		case 'car':
			return 'gas_car';
		case 'gas_car':
		case 'diesel_car':
		case 'electric_car':
		case 'scooter':
		case 'bike':
		case 'pedestrian':
		case 'heavy_vehicle':
			return mode;
		default:
			return 'scooter';
	}
};

export const normalizeRoutingPreferences = (
	value: Partial<RoutingPreferences> | null | undefined
): RoutingPreferences => ({
	...DEFAULT_ROUTING_PREFERENCES,
	...(value ?? {}),
	mode: normalizeRoutingMode(value?.mode)
});
