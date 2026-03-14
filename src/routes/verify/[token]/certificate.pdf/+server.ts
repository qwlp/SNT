import { api } from '../../../../convex/_generated/api';
import { createGenericError, effectRunner } from '$lib/runtime';
import { ConvexPrivateService } from '$lib/services/convex';
import { buildProofPdf } from '$lib/services/proof';
import { Effect } from 'effect';

export const GET = async ({ params, url }) => {
	const response = await effectRunner(
		Effect.gen(function* () {
			const convex = yield* ConvexPrivateService;
			const payload = yield* convex.query({
				func: api.private.proofs.getByToken,
				args: {
					token: params.token
				}
			});

			if (!payload || !payload.user) {
				return null;
			}

			const pdf = yield* buildProofPdf({
				token: payload.certificate.token,
				universityId: payload.certificate.universityId,
				issuedAt: payload.certificate.issuedAt,
				delayMinutes: payload.certificate.delayMinutes,
				studentName: payload.user.displayName,
				evidenceSummary: payload.certificate.evidenceSummary,
				verificationUrl: url.origin + `/verify/${payload.certificate.token}`
			}).pipe(
				Effect.mapError((error) =>
					createGenericError({
						message: error instanceof Error ? error.message : 'Failed to build certificate PDF',
						status: 500,
						kind: 'certificate_pdf_failed',
						cause: error
					})
				)
			);

			return pdf;
		})
	);

	if (response === null) {
		return new Response('Not found', { status: 404 });
	}

	if (response instanceof Response) {
		return response;
	}

	return new Response(response, {
		headers: {
			'Content-Type': 'application/pdf',
			'Content-Disposition': `inline; filename="snt-proof-${params.token.slice(0, 8)}.pdf"`
		}
	});
};
