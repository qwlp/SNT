import { Effect, Schema } from 'effect';
import { clampTrustScore } from '$lib/domain/traffic';

export const TrustScoreInput = Schema.Struct({
	currentTrust: Schema.Number,
	reports: Schema.Number,
	confirmations: Schema.Number,
	expiredLowConfidenceReports: Schema.Number
});

export const calculateTrustScore = (input: typeof TrustScoreInput.Type) =>
	Effect.sync(() => {
		const reportFactor = input.reports === 0 ? 0 : input.confirmations / input.reports;
		const score =
			input.currentTrust +
			reportFactor * 0.45 +
			input.confirmations * 0.03 -
			input.expiredLowConfidenceReports * 0.18;

		return clampTrustScore(score);
	});

export const calculateIncidentConfidence = ({
	reporterTrust,
	confirmations
}: {
	reporterTrust: number;
	confirmations: number;
}) =>
	Effect.sync(() =>
		Number(Math.min(1, Math.max(0.3, reporterTrust / 4.8 + confirmations * 0.12)).toFixed(2))
	);
