import { env } from '$env/dynamic/public';
import { UNIVERSITY_SEEDS, type GeoPoint, type UniversitySeed } from '$lib/domain/traffic';

export interface PlaceSearchResult {
	id: string;
	label: string;
	detail: string;
	point: GeoPoint;
	source: 'preset' | 'coordinates' | 'mapbox';
	presetId: UniversitySeed['id'] | null;
}

interface MapboxGeocodingResponse {
	features?: Array<{
		id?: string;
		text?: string;
		place_name?: string;
		center?: [number, number];
	}>;
}

const normalizeSearchText = (value: string) => value.trim().toLowerCase();

const parseCoordinateQuery = (query: string): GeoPoint | null => {
	const match = query.trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);

	if (!match) {
		return null;
	}

	const lat = Number(match[1]);
	const lng = Number(match[2]);

	if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
		return null;
	}

	if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
		return null;
	}

	return { lat, lng };
};

const searchUniversitySeeds = (query: string): PlaceSearchResult[] => {
	const normalizedQuery = normalizeSearchText(query);

	if (normalizedQuery.length === 0) {
		return [];
	}

	return UNIVERSITY_SEEDS.filter((university) => {
		const haystacks = [university.shortName, university.name, `${university.shortName} campus`].map(
			normalizeSearchText
		);

		return haystacks.some((value) => value.includes(normalizedQuery));
	}).map((university) => ({
		id: `preset-${university.id}`,
		label: university.shortName,
		detail: university.name,
		point: university.campus,
		source: 'preset' as const,
		presetId: university.id
	}));
};

const dedupeResults = (results: PlaceSearchResult[]) => {
	const seen = new Set<string>();

	return results.filter((result) => {
		const key = `${result.label.toLowerCase()}|${result.point.lat.toFixed(5)}|${result.point.lng.toFixed(5)}`;
		if (seen.has(key)) {
			return false;
		}

		seen.add(key);
		return true;
	});
};

const searchMapboxPlaces = async ({
	query,
	limit,
	proximity
}: {
	query: string;
	limit: number;
	proximity?: GeoPoint | null;
}): Promise<PlaceSearchResult[]> => {
	const token = env.PUBLIC_MAPBOX_ACCESS_TOKEN?.trim();

	if (!token) {
		return [];
	}

	const url = new URL(
		`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`
	);
	url.searchParams.set('access_token', token);
	url.searchParams.set('autocomplete', 'true');
	url.searchParams.set('limit', String(limit));
	url.searchParams.set('types', 'poi,address,place,locality,neighborhood');

	if (proximity) {
		url.searchParams.set('proximity', `${proximity.lng},${proximity.lat}`);
	}

	const response = await fetch(url);

	if (!response.ok) {
		return [];
	}

	const data = (await response.json()) as MapboxGeocodingResponse;

	return (data.features ?? [])
		.filter(
			(
				feature
			): feature is NonNullable<MapboxGeocodingResponse['features']>[number] & {
				center: [number, number];
			} => Array.isArray(feature.center) && feature.center.length === 2
		)
		.map((feature, index) => ({
			id: feature.id ?? `mapbox-${index}`,
			label: feature.text?.trim() || feature.place_name?.split(',')[0]?.trim() || 'Search result',
			detail: feature.place_name?.trim() || `${feature.center[1]}, ${feature.center[0]}`,
			point: {
				lat: feature.center[1],
				lng: feature.center[0]
			},
			source: 'mapbox' as const,
			presetId: null
		}));
};

export const searchPlaces = async ({
	query,
	proximity,
	limit = 5
}: {
	query: string;
	proximity?: GeoPoint | null;
	limit?: number;
}): Promise<PlaceSearchResult[]> => {
	const trimmedQuery = query.trim();

	if (trimmedQuery.length === 0) {
		return [];
	}

	const localMatches = searchUniversitySeeds(trimmedQuery);
	const coordinateMatch = parseCoordinateQuery(trimmedQuery);

	const results: PlaceSearchResult[] = [...localMatches];

	if (coordinateMatch) {
		results.unshift({
			id: `coordinates-${coordinateMatch.lat}-${coordinateMatch.lng}`,
			label: 'Dropped coordinates',
			detail: `${coordinateMatch.lat.toFixed(5)}, ${coordinateMatch.lng.toFixed(5)}`,
			point: coordinateMatch,
			source: 'coordinates',
			presetId: null
		});
	}

	try {
		const mapboxResults = await searchMapboxPlaces({
			query: trimmedQuery,
			limit: Math.max(limit, 1),
			proximity
		});

		return dedupeResults([...results, ...mapboxResults]).slice(0, limit);
	} catch {
		return dedupeResults(results).slice(0, limit);
	}
};
