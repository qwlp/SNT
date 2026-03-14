import type { GeoPoint, ViewportBounds } from '$lib/domain/traffic';

const EARTH_RADIUS_METERS = 6_371_000;

const toRadians = (value: number) => (value * Math.PI) / 180;

const toCartesian = (point: GeoPoint) => ({
	x: point.lng * 111_320 * Math.cos(toRadians(point.lat)),
	y: point.lat * 110_540
});

export const haversineMeters = (start: GeoPoint, end: GeoPoint) => {
	const latDelta = toRadians(end.lat - start.lat);
	const lngDelta = toRadians(end.lng - start.lng);
	const startLat = toRadians(start.lat);
	const endLat = toRadians(end.lat);

	const a =
		Math.sin(latDelta / 2) ** 2 +
		Math.cos(startLat) * Math.cos(endLat) * Math.sin(lngDelta / 2) ** 2;

	return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export const distancePointToSegmentMeters = (
	point: GeoPoint,
	segmentStart: GeoPoint,
	segmentEnd: GeoPoint
) => {
	const p = toCartesian(point);
	const a = toCartesian(segmentStart);
	const b = toCartesian(segmentEnd);
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const magnitude = abx * abx + aby * aby;

	if (magnitude === 0) {
		return Math.hypot(p.x - a.x, p.y - a.y);
	}

	const projection = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / magnitude));

	const nearestX = a.x + projection * abx;
	const nearestY = a.y + projection * aby;

	return Math.hypot(p.x - nearestX, p.y - nearestY);
};

export const distancePointToPolylineMeters = (point: GeoPoint, polyline: GeoPoint[]) => {
	if (polyline.length === 0) {
		return Number.POSITIVE_INFINITY;
	}

	if (polyline.length === 1) {
		return haversineMeters(point, polyline[0]);
	}

	let minimumDistance = Number.POSITIVE_INFINITY;

	for (let index = 0; index < polyline.length - 1; index += 1) {
		minimumDistance = Math.min(
			minimumDistance,
			distancePointToSegmentMeters(point, polyline[index], polyline[index + 1])
		);
	}

	return minimumDistance;
};

export const distancePolylineToPolylineMeters = (left: GeoPoint[], right: GeoPoint[]) => {
	let minimumDistance = Number.POSITIVE_INFINITY;

	for (const point of left) {
		minimumDistance = Math.min(minimumDistance, distancePointToPolylineMeters(point, right));
	}

	for (const point of right) {
		minimumDistance = Math.min(minimumDistance, distancePointToPolylineMeters(point, left));
	}

	return minimumDistance;
};

export const boundsFromPoints = (points: GeoPoint[]): ViewportBounds => {
	const latitudes = points.map((point) => point.lat);
	const longitudes = points.map((point) => point.lng);

	return {
		north: Math.max(...latitudes),
		south: Math.min(...latitudes),
		east: Math.max(...longitudes),
		west: Math.min(...longitudes)
	};
};

export const expandBounds = (bounds: ViewportBounds, paddingDegrees: number): ViewportBounds => ({
	north: bounds.north + paddingDegrees,
	south: bounds.south - paddingDegrees,
	east: bounds.east + paddingDegrees,
	west: bounds.west - paddingDegrees
});

export const isNearDestination = (point: GeoPoint, destination: GeoPoint, thresholdMeters = 120) =>
	haversineMeters(point, destination) <= thresholdMeters;
