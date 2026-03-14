<script lang="ts">
	import { resolve } from '$app/paths';
	import AppNavigation from '$lib/components/AppNavigation.svelte';
	import { getClerkContext } from '$lib/stores/clerk.svelte';
	import { trafficDashboard, requestProof } from '$lib/remote/traffic.remote';
	import type { UniversityId } from '$lib/domain/traffic';

	const clerkContext = getClerkContext();

	let dashboard = $state<Awaited<ReturnType<typeof trafficDashboard>> | null>(null);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let selectedUniversity = $state<Partial<Record<string, UniversityId>>>({});
	let issuingFor = $state<string | null>(null);

	const summaryItems = $derived([
		{
			label: 'Eligible trips',
			value: `${dashboard?.routeSessions.length ?? 0}`
		},
		{
			label: 'Certificates',
			value: `${dashboard?.certificates.length ?? 0}`
		}
	]);

	const loadDashboard = async () => {
		loading = true;
		errorMessage = null;

		try {
			dashboard = await trafficDashboard();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to load proof dashboard';
		} finally {
			loading = false;
		}
	};

	$effect(() => {
		if (!clerkContext.currentUser) return;
		void loadDashboard();
	});

	const getSelectedUniversity = (routeSessionId: string): UniversityId =>
		selectedUniversity[routeSessionId] ?? dashboard?.universities[0]?.id ?? 'rupp';

	const createProof = async (routeSessionId: string) => {
		issuingFor = routeSessionId;

		try {
			await requestProof({
				routeSessionId,
				universityId: getSelectedUniversity(routeSessionId)
			});
			await loadDashboard();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to issue proof';
		} finally {
			issuingFor = null;
		}
	};
</script>

{#if !clerkContext.clerk.user}
	<div class="min-h-screen bg-[var(--canvas)] px-4 py-8">
		<div
			class="mx-auto max-w-md rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[0_2px_8px_rgba(36,31,23,0.08)]"
		>
			<h1 class="text-2xl font-semibold">Sign in to SNT</h1>
			<p class="mt-2 text-sm text-[var(--muted)]">
				Proof can only be issued from tracked trips tied to your account.
			</p>
			<div
				class="mt-5"
				{@attach (element) => {
					clerkContext.clerk.mountSignIn(element, {});
				}}
			></div>
		</div>
	</div>
{:else}
	<div class="min-h-screen bg-[var(--canvas)] text-[var(--text)]">
		<div class="mx-auto max-w-[1360px] px-4 py-4 sm:px-6 lg:px-8">
			<div class="grid gap-4 lg:grid-cols-[248px_minmax(0,1fr)]">
				<AppNavigation active="proof" summary={summaryItems} />

				<main class="space-y-4">
					<header
						class="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-5 py-4 shadow-[0_2px_8px_rgba(36,31,23,0.08)]"
					>
						<div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
							<div>
								<h1 class="text-2xl font-semibold">Delay certificates</h1>
								<p class="mt-1 text-sm text-[var(--muted)]">
									Issue proof from completed route sessions and review every certificate already
									generated.
								</p>
							</div>
							<a
								href={resolve('/app?tab=route')}
								class="rounded-[8px] border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-2 text-sm font-medium text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--primary-soft)]"
							>
								Back to route planning
							</a>
						</div>
					</header>

					{#if loading}
						<div
							class="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-5 py-6 text-sm text-[var(--muted)] shadow-[0_2px_8px_rgba(36,31,23,0.08)]"
						>
							Loading proof dashboard...
						</div>
					{:else}
						<div class="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
							<section
								class="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] shadow-[0_2px_8px_rgba(36,31,23,0.08)]"
							>
								<div class="border-b border-[var(--border)] px-5 py-4">
									<h2 class="text-lg font-semibold">Eligible trips</h2>
									<p class="mt-1 text-sm text-[var(--muted)]">
										Completed sessions can issue proof. In-progress sessions stay visible but
										disabled.
									</p>
								</div>

								{#if (dashboard?.routeSessions.length ?? 0) === 0}
									<p class="px-5 py-6 text-sm text-[var(--muted)]">
										No tracked trips available yet.
									</p>
								{:else}
									<div class="divide-y divide-[var(--border)]">
										{#each dashboard?.routeSessions ?? [] as session (session._id)}
											<div class="px-5 py-4">
												<div
													class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"
												>
													<div>
														<p class="text-sm font-medium text-[var(--text)]">
															Trip #{session._id.slice(-6)}
														</p>
														<p class="mt-1 text-sm text-[var(--muted)]">
															Started {new Date(session.startedAt).toLocaleString('en-US')}
														</p>
														<p class="mt-1 text-sm text-[var(--muted)]">
															Baseline {Math.round(session.baselineEtaSec / 60)} minutes
														</p>
													</div>

													<div class="text-sm text-[var(--muted)] lg:text-right">
														<p>{session.arrivedAt ? 'Completed' : 'In progress'}</p>
														<p>{session.locationSamplesCount} location samples</p>
													</div>
												</div>

												<div class="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_170px]">
													<select
														bind:value={selectedUniversity[session._id]}
														class="w-full rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-sm text-[var(--text)] outline-none focus:border-[var(--border-strong)]"
													>
														{#each dashboard?.universities ?? [] as university (university.id)}
															<option value={university.id}>{university.shortName}</option>
														{/each}
													</select>

													<button
														type="button"
														onclick={() => createProof(session._id)}
														disabled={!session.arrivedAt || issuingFor === session._id}
														class="rounded-[8px] bg-[var(--primary)] px-4 py-3 text-sm font-medium text-white hover:bg-[#5a4229] disabled:opacity-50"
													>
														{issuingFor === session._id ? 'Issuing proof...' : 'Issue proof'}
													</button>
												</div>
											</div>
										{/each}
									</div>
								{/if}
							</section>

							<section
								class="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] shadow-[0_2px_8px_rgba(36,31,23,0.08)]"
							>
								<div class="border-b border-[var(--border)] px-5 py-4">
									<h2 class="text-lg font-semibold">Issued certificates</h2>
									<p class="mt-1 text-sm text-[var(--muted)]">
										Every generated certificate remains available through its verification link and
										PDF.
									</p>
								</div>

								{#if (dashboard?.certificates.length ?? 0) === 0}
									<p class="px-5 py-6 text-sm text-[var(--muted)]">No certificates issued yet.</p>
								{:else}
									<div class="divide-y divide-[var(--border)]">
										{#each dashboard?.certificates ?? [] as certificate (certificate._id)}
											<div class="px-5 py-4">
												<p class="text-sm font-medium text-[var(--text)]">
													{certificate.university.shortName} certificate
												</p>
												<p class="mt-1 text-sm text-[var(--muted)]">
													{certificate.delayMinutes} minute delay, issued {new Date(
														certificate.issuedAt
													).toLocaleString('en-US')}
												</p>

												<div class="mt-4 flex flex-wrap gap-3">
													<a
														href={resolve(`/verify/${certificate.token}`)}
														class="rounded-[8px] border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-2 text-sm font-medium text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--primary-soft)]"
													>
														Open verification page
													</a>
													<a
														href={resolve(`/verify/${certificate.token}/certificate.pdf`)}
														class="rounded-[8px] bg-[var(--primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[#5a4229]"
													>
														Download PDF
													</a>
												</div>
											</div>
										{/each}
									</div>
								{/if}
							</section>
						</div>
					{/if}

					{#if errorMessage}
						<p
							class="rounded-[10px] border border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]"
						>
							{errorMessage}
						</p>
					{/if}
				</main>
			</div>
		</div>
	</div>
{/if}
