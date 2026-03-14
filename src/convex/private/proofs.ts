import type { Doc } from '../_generated/dataModel';
import { v } from 'convex/values';
import { getUniversitySeed } from '../../lib/domain/traffic';
import { privateMutation, privateQuery } from './helpers';

export const createCertificate = privateMutation({
	args: {
		userId: v.id('users'),
		routeSessionId: v.id('routeSessions'),
		universityId: v.union(v.literal('rupp'), v.literal('itc'), v.literal('num')),
		delayMinutes: v.number(),
		token: v.string(),
		evidenceSummary: v.array(v.string()),
		routeExplanationChips: v.array(v.string()),
		incidentIds: v.array(v.id('incidents'))
	},
	handler: async (ctx, args) => {
		const certificates = (await ctx.db
			.query('proofCertificates')
			.collect()) as Doc<'proofCertificates'>[];
		const existing = certificates.find(
			(certificate) => certificate.routeSessionId === args.routeSessionId
		);

		if (existing) {
			return existing;
		}

		const certificateId = await ctx.db.insert('proofCertificates', {
			...args,
			status: 'valid',
			issuedAt: Date.now(),
			city: 'phnom_penh'
		});

		return await ctx.db.get(certificateId);
	}
});

export const getByToken = privateQuery({
	args: {
		token: v.string()
	},
	handler: async (ctx, args) => {
		const certificates = (await ctx.db
			.query('proofCertificates')
			.collect()) as Doc<'proofCertificates'>[];
		const certificate = certificates.find((record) => record.token === args.token) ?? null;

		if (!certificate) {
			return null;
		}

		const [user, routeSession, incidents] = await Promise.all([
			ctx.db.get(certificate.userId),
			ctx.db.get(certificate.routeSessionId),
			Promise.all(
				certificate.incidentIds.map((incidentId: Doc<'incidents'>['_id']) => ctx.db.get(incidentId))
			)
		]);

		return {
			certificate,
			user,
			routeSession,
			university: getUniversitySeed(certificate.universityId),
			incidents: incidents.filter(Boolean)
		};
	}
});

export const markVerified = privateMutation({
	args: {
		token: v.string()
	},
	handler: async (ctx, args) => {
		const certificates = (await ctx.db
			.query('proofCertificates')
			.collect()) as Doc<'proofCertificates'>[];
		const certificate = certificates.find((record) => record.token === args.token) ?? null;

		if (!certificate) {
			return null;
		}

		await ctx.db.patch(certificate._id, {
			verifiedAt: Date.now()
		});

		return await ctx.db.get(certificate._id);
	}
});

export const listForUser = privateQuery({
	args: {
		userId: v.id('users')
	},
	handler: async (ctx, args) => {
		const certificates = (await ctx.db
			.query('proofCertificates')
			.collect()) as Doc<'proofCertificates'>[];

		return certificates
			.filter((certificate) => certificate.userId === args.userId)
			.map((certificate: Doc<'proofCertificates'>) => ({
				...certificate,
				university: getUniversitySeed(certificate.universityId)
			}))
			.sort(
				(
					left: Doc<'proofCertificates'> & { university: ReturnType<typeof getUniversitySeed> },
					right: Doc<'proofCertificates'> & { university: ReturnType<typeof getUniversitySeed> }
				) => right.issuedAt - left.issuedAt
			);
	}
});
