import { UNIVERSITY_SEEDS, type GeoPoint, type UniversitySeed } from '$lib/domain/traffic';

export interface PlaceSearchResult {
	id: string;
	label: string;
	detail: string;
	point: GeoPoint;
	source: 'preset' | 'coordinates' | 'mapbox' | 'nominatim';
	presetId: UniversitySeed['id'] | null;
}

interface RemotePlaceSearchResult {
	id: string;
	label: string;
	detail: string;
	point: GeoPoint;
	source: 'mapbox' | 'nominatim';
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

const searchRemotePlaces = async ({
	query,
	limit,
	proximity
}: {
	query: string;
	limit: number;
	proximity?: GeoPoint | null;
}): Promise<PlaceSearchResult[]> => {
	const url = new URL('/api/place-search', window.location.origin);
	url.searchParams.set('q', query);
	url.searchParams.set('limit', String(limit));

	if (proximity) {
		url.searchParams.set('lat', String(proximity.lat));
		url.searchParams.set('lng', String(proximity.lng));
	}

	const response = await fetch(url);

	if (!response.ok) {
		return [];
	}

	const payload = (await response.json()) as { results?: RemotePlaceSearchResult[] };

	return (payload.results ?? []).map((result) => ({
		...result,
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
		const remoteResults = await searchRemotePlaces({
			query: trimmedQuery,
			limit: Math.max(limit * 3, 10),
			proximity
		});

		return dedupeResults([...results, ...remoteResults]).slice(0, limit);
	} catch {
		return dedupeResults(results).slice(0, limit);
	}
};
