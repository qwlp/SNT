import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import { haversineMeters } from '$lib/services/geo';
import type { RequestHandler } from './$types';

interface SearchResult {
	id: string;
	label: string;
	detail: string;
	point: {
		lat: number;
		lng: number;
	};
	source: 'mapbox' | 'nominatim';
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
			short_code?: string;
		}>;
	}>;
}

interface NominatimSearchResult {
	place_id?: number;
	lat?: string;
	lon?: string;
	name?: string;
	display_name?: string;
	type?: string;
	category?: string;
	importance?: number;
}

const CAMBODIA_CENTER = {
	lat: 12.5657,
	lng: 104.991
};

const CAMBODIA_BOUNDS = {
	west: 102.333,
	south: 10.409,
	east: 107.627,
	north: 14.69
};

const MAPBOX_TYPES = ['address', 'place', 'locality', 'neighborhood', 'district', 'region'].join(
	','
);

const normalizeSearchText = (value: string) => value.trim().toLowerCase();

const dedupeResults = (results: SearchResult[]) => {
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
	point: { lat: number; lng: number }
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

const scoreMapboxFeature = ({
	feature,
	point,
	query,
	proximity
}: {
	feature: NonNullable<MapboxGeocodingResponse['features']>[number];
	point: { lat: number; lng: number };
	query: string;
	proximity?: { lat: number; lng: number } | null;
}) => {
	const normalizedQuery = normalizeSearchText(query);
	const label = normalizeSearchText(feature.text ?? '');
	const detail = normalizeSearchText(feature.place_name ?? '');
	const exactLabelMatch = label === normalizedQuery;
	const labelStartsWithQuery = label.startsWith(normalizedQuery);
	const labelIncludesQuery = label.includes(normalizedQuery);
	const detailIncludesQuery = detail.includes(normalizedQuery);
	const localToCambodia = isInCambodia(feature, point);
	const distanceMeters = haversineMeters(proximity ?? CAMBODIA_CENTER, point);

	let score = feature.relevance ?? 0;

	if (localToCambodia) score += 6;
	if (exactLabelMatch) score += 4;
	if (labelStartsWithQuery) score += 2;
	if (labelIncludesQuery) score += 1.5;
	if (detailIncludesQuery) score += 1;
	if (distanceMeters < 2_000) score += 2;
	else if (distanceMeters < 10_000) score += 1;

	return score;
};

const scoreNominatimFeature = ({
	result,
	query,
	proximity,
	point
}: {
	result: NominatimSearchResult;
	query: string;
	proximity?: { lat: number; lng: number } | null;
	point: { lat: number; lng: number };
}) => {
	const normalizedQuery = normalizeSearchText(query);
	const label = normalizeSearchText(result.name ?? result.display_name?.split(',')[0] ?? '');
	const detail = normalizeSearchText(result.display_name ?? '');
	const category = normalizeSearchText(result.category ?? '');
	const type = normalizeSearchText(result.type ?? '');
	const exactLabelMatch = label === normalizedQuery;
	const labelStartsWithQuery = label.startsWith(normalizedQuery);
	const labelIncludesQuery = label.includes(normalizedQuery);
	const detailIncludesQuery = detail.includes(normalizedQuery);
	const distanceMeters = haversineMeters(proximity ?? CAMBODIA_CENTER, point);

	let score = result.importance ?? 0;

	if (exactLabelMatch) score += 6;
	if (labelStartsWithQuery) score += 3;
	if (labelIncludesQuery) score += 2;
	if (detailIncludesQuery) score += 1;
	if (category === 'amenity' || category === 'shop' || category === 'tourism') score += 4;
	if (type === 'school' || type === 'university' || type === 'college') score += 3;
	if (type === 'cafe' || type === 'restaurant' || type === 'mall') score += 2;
	if (distanceMeters < 2_000) score += 2.5;
	else if (distanceMeters < 10_000) score += 1.5;
	else if (distanceMeters < 50_000) score += 0.5;

	return score;
};

const searchMapboxPlaces = async ({
	query,
	limit,
	proximity
}: {
	query: string;
	limit: number;
	proximity?: { lat: number; lng: number } | null;
}) => {
	const token = env.MAPBOX_ACCESS_TOKEN?.trim();

	if (!token) {
		return [] satisfies SearchResult[];
	}

	const url = new URL(
		`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`
	);
	url.searchParams.set('access_token', token);
	url.searchParams.set('autocomplete', 'true');
	url.searchParams.set('limit', String(limit));
	url.searchParams.set('types', MAPBOX_TYPES);
	url.searchParams.set('language', 'en');
	url.searchParams.set('country', 'kh');
	url.searchParams.set(
		'bbox',
		`${CAMBODIA_BOUNDS.west},${CAMBODIA_BOUNDS.south},${CAMBODIA_BOUNDS.east},${CAMBODIA_BOUNDS.north}`
	);

	if (proximity) {
		url.searchParams.set('proximity', `${proximity.lng},${proximity.lat}`);
	}

	const response = await fetch(url);

	if (!response.ok) {
		return [] satisfies SearchResult[];
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
			const leftPoint = { lat: left.center[1], lng: left.center[0] };
			const rightPoint = { lat: right.center[1], lng: right.center[0] };

			return (
				scoreMapboxFeature({ feature: right, point: rightPoint, query, proximity }) -
				scoreMapboxFeature({ feature: left, point: leftPoint, query, proximity })
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
			source: 'mapbox' as const
		}));
};

const searchNominatimPlaces = async ({
	query,
	limit,
	proximity,
	focusAroundUser
}: {
	query: string;
	limit: number;
	proximity?: { lat: number; lng: number } | null;
	focusAroundUser: boolean;
}) => {
	const url = new URL('https://nominatim.openstreetmap.org/search');
	url.searchParams.set('q', query);
	url.searchParams.set('countrycodes', 'kh');
	url.searchParams.set('format', 'jsonv2');
	url.searchParams.set('limit', String(limit));
	url.searchParams.set('addressdetails', '1');
	url.searchParams.set('accept-language', 'en');

	if (focusAroundUser && proximity) {
		const lngDelta = 0.35;
		const latDelta = 0.28;
		url.searchParams.set(
			'viewbox',
			`${proximity.lng - lngDelta},${proximity.lat + latDelta},${proximity.lng + lngDelta},${proximity.lat - latDelta}`
		);
	}

	const response = await fetch(url, {
		headers: {
			'user-agent': 'SNT/1.0 place search'
		}
	});

	if (!response.ok) {
		return [] satisfies SearchResult[];
	}

	const data = (await response.json()) as NominatimSearchResult[];

	return data
		.map((result) => {
			const lat = Number(result.lat);
			const lng = Number(result.lon);

			if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
				return null;
			}

			return {
				result,
				point: { lat, lng }
			};
		})
		.filter(
			(entry): entry is { result: NominatimSearchResult; point: { lat: number; lng: number } } =>
				Boolean(entry)
		)
		.sort((left, right) => {
			return (
				scoreNominatimFeature({
					result: right.result,
					query,
					proximity,
					point: right.point
				}) -
				scoreNominatimFeature({
					result: left.result,
					query,
					proximity,
					point: left.point
				})
			);
		})
		.map(({ result, point }, index) => ({
			id: `nominatim-${result.place_id ?? index}`,
			label: result.name?.trim() || result.display_name?.split(',')[0]?.trim() || 'Search result',
			detail: result.display_name?.trim() || `${point.lat}, ${point.lng}`,
			point,
			source: 'nominatim' as const
		}));
};

export const GET: RequestHandler = async ({ url }) => {
	const query = url.searchParams.get('q')?.trim() ?? '';
	const limit = Math.max(1, Math.min(12, Number(url.searchParams.get('limit') ?? '6') || 6));
	const lat = Number(url.searchParams.get('lat'));
	const lng = Number(url.searchParams.get('lng'));
	const proximity =
		Number.isFinite(lat) && Number.isFinite(lng)
			? {
					lat,
					lng
				}
			: null;

	if (query.length < 2) {
		return json({ results: [] satisfies SearchResult[] });
	}

	const requestLimit = Math.max(limit * 2, 8);

	try {
		const [mapboxResults, nominatimResults, focusedNominatimResults] = await Promise.all([
			searchMapboxPlaces({
				query,
				limit: requestLimit,
				proximity
			}),
			searchNominatimPlaces({
				query,
				limit: requestLimit,
				proximity,
				focusAroundUser: false
			}),
			searchNominatimPlaces({
				query,
				limit: requestLimit,
				proximity,
				focusAroundUser: query.length <= 4
			})
		]);

		return json({
			results: dedupeResults([
				...focusedNominatimResults,
				...nominatimResults,
				...mapboxResults
			]).slice(0, limit)
		});
	} catch {
		return json({ results: [] satisfies SearchResult[] });
	}
};
