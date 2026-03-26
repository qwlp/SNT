import { env } from '$env/dynamic/public';
import { UNIVERSITY_SEEDS, type GeoPoint, type UniversitySeed } from '$lib/domain/traffic';
import { haversineMeters } from './geo';

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
		place_type?: string[];
		relevance?: number;
		properties?: {
			category?: string;
			short_code?: string;
		};
		context?: Array<{
			id?: string;
			short_code?: string;
			text?: string;
		}>;
	}>;
}

const CAMBODIA_CENTER: GeoPoint = {
	lat: 12.5657,
	lng: 104.991
};

const CAMBODIA_BOUNDS = {
	west: 102.333,
	south: 10.409,
	east: 107.627,
	north: 14.69
};

const CAMBODIA_SEARCH_TYPES = [
	'poi',
	'poi.landmark',
	'address',
	'place',
	'locality',
	'neighborhood',
	'district',
	'region'
].join(',');

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

const isInCambodia = (
	feature: NonNullable<MapboxGeocodingResponse['features']>[number],
	point: GeoPoint
) => {
	const shortCodes = [
		feature.properties?.short_code,
		...(feature.context ?? []).map((entry) => entry.short_code)
	]
		.filter((value): value is string => Boolean(value))
		.map((value) => value.toLowerCase());

	if (shortCodes.includes('kh') || shortCodes.includes('kh-kh')) {
		return true;
	}

	const placeName = feature.place_name?.toLowerCase() ?? '';
	const matchesBounds =
		point.lng >= CAMBODIA_BOUNDS.west &&
		point.lng <= CAMBODIA_BOUNDS.east &&
		point.lat >= CAMBODIA_BOUNDS.south &&
		point.lat <= CAMBODIA_BOUNDS.north;

	return matchesBounds || placeName.includes('cambodia');
};

const scoreFeature = ({
	feature,
	point,
	query,
	proximity
}: {
	feature: NonNullable<MapboxGeocodingResponse['features']>[number];
	point: GeoPoint;
	query: string;
	proximity?: GeoPoint | null;
}) => {
	const normalizedQuery = normalizeSearchText(query);
	const label = normalizeSearchText(feature.text ?? '');
	const detail = normalizeSearchText(feature.place_name ?? '');
	const placeTypes = new Set(feature.place_type ?? []);
	const categories = normalizeSearchText(feature.properties?.category ?? '');
	const exactLabelMatch = label === normalizedQuery;
	const labelStartsWithQuery = label.startsWith(normalizedQuery);
	const labelIncludesQuery = label.includes(normalizedQuery);
	const detailIncludesQuery = detail.includes(normalizedQuery);
	const localToCambodia = isInCambodia(feature, point);
	const isPreciseLocation =
		placeTypes.has('poi') || placeTypes.has('address') || placeTypes.has('street');
	const distanceMeters = haversineMeters(proximity ?? CAMBODIA_CENTER, point);

	let score = feature.relevance ?? 0;

	if (localToCambodia) score += 8;
	if (isPreciseLocation) score += 5;
	if (exactLabelMatch) score += 5;
	if (labelStartsWithQuery) score += 3;
	if (labelIncludesQuery) score += 2;
	if (detailIncludesQuery) score += 1;
	if (categories.includes('school') || categories.includes('university')) score += 1.5;
	if (distanceMeters < 2_000) score += 2.5;
	else if (distanceMeters < 10_000) score += 1.5;
	else if (distanceMeters < 50_000) score += 0.75;

	return score;
};

const searchMapboxPlaces = async ({
	query,
	limit,
	proximity,
	countries,
	bbox
}: {
	query: string;
	limit: number;
	proximity?: GeoPoint | null;
	countries?: string;
	bbox?: { west: number; south: number; east: number; north: number };
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
	url.searchParams.set('types', CAMBODIA_SEARCH_TYPES);
	url.searchParams.set('language', 'en');

	if (proximity) {
		url.searchParams.set('proximity', `${proximity.lng},${proximity.lat}`);
	}

	if (countries) {
		url.searchParams.set('country', countries);
	}

	if (bbox) {
		url.searchParams.set('bbox', `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`);
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
		.sort((left, right) => {
			const leftPoint = {
				lat: left.center[1],
				lng: left.center[0]
			};
			const rightPoint = {
				lat: right.center[1],
				lng: right.center[0]
			};

			return (
				scoreFeature({ feature: right, point: rightPoint, query, proximity }) -
				scoreFeature({ feature: left, point: leftPoint, query, proximity })
			);
		})
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
		const requestLimit = Math.max(limit * 3, 10);
		const [cambodiaResults, cambodiaNamedResults, globalResults] = await Promise.all([
			searchMapboxPlaces({
				query: trimmedQuery,
				limit: requestLimit,
				proximity,
				countries: 'kh',
				bbox: CAMBODIA_BOUNDS
			}),
			searchMapboxPlaces({
				query: `${trimmedQuery}, Cambodia`,
				limit: requestLimit,
				proximity,
				countries: 'kh',
				bbox: CAMBODIA_BOUNDS
			}),
			searchMapboxPlaces({
				query: trimmedQuery,
				limit: requestLimit,
				proximity
			})
		]);

		return dedupeResults([
			...results,
			...cambodiaResults,
			...cambodiaNamedResults,
			...globalResults
		]).slice(0, limit);
	} catch {
		return dedupeResults(results).slice(0, limit);
	}
};
