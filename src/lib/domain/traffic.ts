export const CITY = 'phnom_penh' as const;

export const INCIDENT_TYPES = [
	'roadblock',
	'vip',
	'wedding',
	'flood',
	'accident',
	'police'
] as const;
export const INCIDENT_STATUSES = ['active', 'expired'] as const;
export const PROOF_STATUSES = ['valid', 'revoked'] as const;
export const UNIVERSITY_IDS = ['rupp', 'itc', 'num'] as const;
export const USER_ROLES = ['citizen', 'campus_rep'] as const;

export type City = typeof CITY;
export type IncidentType = (typeof INCIDENT_TYPES)[number];
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type ProofStatus = (typeof PROOF_STATUSES)[number];
export type UniversityId = (typeof UNIVERSITY_IDS)[number];
export type UserRole = (typeof USER_ROLES)[number];

export interface GeoPoint {
	lat: number;
	lng: number;
}

export interface ViewportBounds {
	north: number;
	south: number;
	east: number;
	west: number;
}

export interface ShortcutSeed {
	name: string;
	polyline: GeoPoint[];
	weight: number;
	source: 'seed';
}

export interface UniversitySeed {
	id: UniversityId;
	name: string;
	shortName: string;
	targetUsers: number;
	repTarget: number;
	campus: GeoPoint;
}

export const PHNOM_PENH_CENTER: GeoPoint = {
	lat: 11.5564,
	lng: 104.9282
};

export const PHNOM_PENH_BOUNDS: ViewportBounds = {
	north: 11.65,
	south: 11.46,
	east: 105.02,
	west: 104.84
};

export const INCIDENT_LABELS: Record<IncidentType, { en: string; km: string }> = {
	roadblock: { en: 'Roadblock', km: 'បិទផ្លូវ' },
	vip: { en: 'VIP Block', km: 'VIP' },
	wedding: { en: 'Wedding', km: 'មង្គលការ' },
	flood: { en: 'Flood', km: 'ទឹកជំនន់' },
	accident: { en: 'Accident', km: 'គ្រោះថ្នាក់' },
	police: { en: 'Police', km: 'ប៉ូលិស' }
};

export const INCIDENT_EXPIRY_MINUTES: Record<IncidentType, number> = {
	roadblock: 240,
	accident: 90,
	police: 120,
	vip: 180,
	wedding: 240,
	flood: 480
};

export const INCIDENT_ROUTE_PENALTY: Record<IncidentType, number> = {
	roadblock: 840,
	flood: 780,
	vip: 600,
	accident: 480,
	police: 240,
	wedding: 180
};

export const PROOF_DELAY_MINUTES_THRESHOLD = 10;
export const PROOF_DELAY_PERCENT_THRESHOLD = 0.2;
export const MIN_PROOF_LOCATION_SAMPLES = 2;
export const DEFAULT_TRUST_SCORE = 2;
export const MAX_TRUST_SCORE = 5;

export const UNIVERSITY_SEEDS: UniversitySeed[] = [
	{
		id: 'rupp',
		name: 'Royal University of Phnom Penh',
		shortName: 'RUPP',
		targetUsers: 2000,
		repTarget: 5,
		campus: {
			lat: 11.5701,
			lng: 104.8899
		}
	},
	{
		id: 'itc',
		name: 'Institute of Technology of Cambodia',
		shortName: 'ITC',
		targetUsers: 800,
		repTarget: 3,
		campus: {
			lat: 11.5732,
			lng: 104.8998
		}
	},
	{
		id: 'num',
		name: 'National University of Management',
		shortName: 'NUM',
		targetUsers: 1500,
		repTarget: 4,
		campus: {
			lat: 11.5597,
			lng: 104.9273
		}
	}
];

export const SHORTCUT_SEEDS: ShortcutSeed[] = [
	{
		name: 'Toul Kork Santha',
		polyline: [
			{ lat: 11.5718, lng: 104.8888 },
			{ lat: 11.5736, lng: 104.8926 },
			{ lat: 11.5754, lng: 104.8955 }
		],
		weight: 0.42,
		source: 'seed'
	},
	{
		name: 'Russian Blvd Cutthrough',
		polyline: [
			{ lat: 11.5458, lng: 104.8854 },
			{ lat: 11.5466, lng: 104.8896 },
			{ lat: 11.5484, lng: 104.8941 }
		],
		weight: 0.56,
		source: 'seed'
	},
	{
		name: 'Boeung Keng Kang Alley',
		polyline: [
			{ lat: 11.5439, lng: 104.9262 },
			{ lat: 11.5418, lng: 104.9285 },
			{ lat: 11.5394, lng: 104.9311 }
		],
		weight: 0.35,
		source: 'seed'
	}
];

export const clampTrustScore = (value: number) =>
	Math.max(0.5, Math.min(MAX_TRUST_SCORE, Number.isFinite(value) ? value : DEFAULT_TRUST_SCORE));

export const calculateIncidentExpiry = (type: IncidentType, timestamp: number) =>
	timestamp + INCIDENT_EXPIRY_MINUTES[type] * 60_000;

export const isPointInViewport = (point: GeoPoint, viewport?: ViewportBounds | null) => {
	if (!viewport) return true;

	return (
		point.lat <= viewport.north &&
		point.lat >= viewport.south &&
		point.lng <= viewport.east &&
		point.lng >= viewport.west
	);
};

export const getUniversitySeed = (id: UniversityId) =>
	UNIVERSITY_SEEDS.find((university) => university.id === id) ?? UNIVERSITY_SEEDS[0];
