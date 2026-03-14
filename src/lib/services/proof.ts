import { Buffer } from 'node:buffer';
import QRCode from 'qrcode';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Effect } from 'effect';
import {
	MIN_PROOF_LOCATION_SAMPLES,
	PROOF_DELAY_MINUTES_THRESHOLD,
	PROOF_DELAY_PERCENT_THRESHOLD,
	getUniversitySeed
} from '$lib/domain/traffic';

interface ProofEligibilityInput {
	baselineEtaSec: number;
	actualDurationSec?: number;
	locationSamplesCount: number;
	arrivedAt?: number;
	incidentCount: number;
	routeExplanationChips: string[];
}

export interface ProofEligibilityResult {
	eligible: boolean;
	delayMinutes: number;
	reasons: string[];
	evidenceSummary: string[];
}

export const evaluateProofEligibility = ({
	baselineEtaSec,
	actualDurationSec,
	locationSamplesCount,
	arrivedAt,
	incidentCount,
	routeExplanationChips
}: ProofEligibilityInput) =>
	Effect.sync(() => {
		const reasons: string[] = [];
		const evidenceSummary: string[] = [];

		if (!arrivedAt || !actualDurationSec) {
			reasons.push('Trip has not been completed.');
		}

		if (locationSamplesCount < MIN_PROOF_LOCATION_SAMPLES) {
			reasons.push('At least 2 location samples are required.');
		}

		if (incidentCount === 0 && routeExplanationChips.length === 0) {
			reasons.push('No traffic evidence overlapped the route.');
		}

		const actualDelaySec = Math.max(0, (actualDurationSec ?? 0) - baselineEtaSec);
		const delayMinutes = Math.ceil(actualDelaySec / 60);
		const requiredDelaySec = Math.max(
			PROOF_DELAY_MINUTES_THRESHOLD * 60,
			Math.round(baselineEtaSec * PROOF_DELAY_PERCENT_THRESHOLD)
		);

		if (actualDelaySec < requiredDelaySec) {
			reasons.push('Delay threshold not met.');
		}

		evidenceSummary.push(`Baseline ETA ${Math.round(baselineEtaSec / 60)} min`);
		evidenceSummary.push(`Observed duration ${Math.round((actualDurationSec ?? 0) / 60)} min`);
		evidenceSummary.push(`Location samples ${locationSamplesCount}`);

		if (incidentCount > 0) {
			evidenceSummary.push(`Traffic incidents matched ${incidentCount}`);
		}

		if (routeExplanationChips.length > 0) {
			evidenceSummary.push(routeExplanationChips.join(', '));
		}

		return {
			eligible: reasons.length === 0,
			delayMinutes,
			reasons,
			evidenceSummary
		} satisfies ProofEligibilityResult;
	});

interface PdfCertificateInput {
	token: string;
	universityId: 'rupp' | 'itc' | 'num';
	issuedAt: number;
	delayMinutes: number;
	studentName: string;
	evidenceSummary: string[];
	verificationUrl: string;
}

const decodeDataUrl = (value: string) =>
	Uint8Array.from(Buffer.from(value.split(',')[1], 'base64'));

export const buildProofPdf = (input: PdfCertificateInput) =>
	Effect.tryPromise({
		try: async () => {
			const pdf = await PDFDocument.create();
			const page = pdf.addPage([612, 792]);
			const headingFont = await pdf.embedFont(StandardFonts.HelveticaBold);
			const bodyFont = await pdf.embedFont(StandardFonts.Helvetica);
			const qrPng = await QRCode.toDataURL(input.verificationUrl, {
				margin: 1,
				width: 220
			});
			const qrImage = await pdf.embedPng(decodeDataUrl(qrPng));

			page.drawRectangle({
				x: 36,
				y: 36,
				width: 540,
				height: 720,
				color: rgb(0.98, 0.95, 0.89)
			});
			page.drawText('SNT Traffic Delay Certificate', {
				x: 52,
				y: 718,
				size: 24,
				font: headingFont,
				color: rgb(0.17, 0.16, 0.12)
			});
			page.drawText('Phnom Penh only', {
				x: 52,
				y: 690,
				size: 12,
				font: bodyFont,
				color: rgb(0.35, 0.31, 0.24)
			});
			page.drawText(`Student: ${input.studentName}`, {
				x: 52,
				y: 642,
				size: 14,
				font: bodyFont
			});
			page.drawText(`University: ${getUniversitySeed(input.universityId).name}`, {
				x: 52,
				y: 620,
				size: 14,
				font: bodyFont
			});
			page.drawText(`Delay certified: ${input.delayMinutes} minutes`, {
				x: 52,
				y: 598,
				size: 14,
				font: bodyFont
			});
			page.drawText(`Issued: ${new Date(input.issuedAt).toLocaleString('en-US')}`, {
				x: 52,
				y: 576,
				size: 14,
				font: bodyFont
			});
			page.drawText(`Certificate token: ${input.token}`, {
				x: 52,
				y: 554,
				size: 12,
				font: bodyFont
			});
			page.drawText('Evidence summary', {
				x: 52,
				y: 510,
				size: 16,
				font: headingFont
			});

			input.evidenceSummary.slice(0, 6).forEach((line, index) => {
				page.drawText(`• ${line}`, {
					x: 58,
					y: 486 - index * 22,
					size: 12,
					font: bodyFont
				});
			});

			page.drawImage(qrImage, {
				x: 388,
				y: 458,
				width: 160,
				height: 160
			});
			page.drawText('Scan to verify', {
				x: 410,
				y: 438,
				size: 11,
				font: bodyFont
			});
			page.drawText(input.verificationUrl, {
				x: 52,
				y: 92,
				size: 10,
				font: bodyFont
			});

			return Buffer.from(await pdf.save());
		},
		catch: (cause) => new Error(cause instanceof Error ? cause.message : 'Failed to build PDF')
	});
