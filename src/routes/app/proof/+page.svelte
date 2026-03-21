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

	const routeSessions = $derived(dashboard?.routeSessions ?? []);
	const completedSessions = $derived(routeSessions.filter((session) => Boolean(session.arrivedAt)));
	const certificates = $derived(dashboard?.certificates ?? []);

	const summaryItems = $derived([
		{ label: 'Trips', value: `${routeSessions.length}` },
		{ label: 'Proofs', value: `${certificates.length}` }
	]);

	const formatDateTime = (timestamp: number) =>
		new Date(timestamp).toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	const formatMinutes = (seconds: number) => `${Math.max(1, Math.round(seconds / 60))} min`;
	const getSelectedUniversity = (routeSessionId: string): UniversityId =>
		selectedUniversity[routeSessionId] ?? dashboard?.universities[0]?.id ?? 'rupp';

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

{#if !clerkContext.currentUser}
	<div class="min-h-screen bg-[var(--canvas)] px-4 py-8 sm:px-6 lg:px-8">
		<div class="mx-auto max-w-md">
			<div class="border border-[var(--border)] bg-[var(--surface)] p-6">
				<p class="text-xl font-semibold text-[var(--text)]">Entering demo</p>
				{#if clerkContext.guestBootstrapFailed}
					<p class="mt-2 text-sm text-[var(--danger)]">{clerkContext.guestBootstrapFailed}</p>
				{:else}
					<p class="mt-2 text-sm text-[var(--muted)]">
						Starting an anonymous guest session for the proof dashboard.
					</p>
				{/if}
			</div>
		</div>
	</div>
{:else}
	<div class="min-h-screen bg-[var(--canvas)] text-[var(--text)]">
		<div class="mx-auto max-w-[1440px] px-4 py-4 sm:px-6 lg:px-8">
			<div class="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
				<AppNavigation active="proof" summary={summaryItems} />

				<main class="space-y-4">
					<header class="border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
						<div class="flex flex-wrap items-center justify-between gap-3">
							<div class="flex items-center gap-3">
								<div
									class="flex h-12 w-12 items-center justify-center border border-[var(--primary)] bg-[var(--primary)] text-white"
								>
									<svg
										viewBox="0 0 24 24"
										class="h-6 w-6"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<path d="M7 4.5h7l3 3V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z" />
										<path d="M14 4.5V8h3" />
										<path d="M8 12h8" />
										<path d="M8 16h5" />
									</svg>
								</div>
								<div>
									<p class="text-sm font-semibold text-[var(--text)]">Proof</p>
									<div class="mt-1 flex items-center gap-3 text-sm text-[var(--muted)]">
										<span class="inline-flex items-center gap-1.5">
											<svg
												viewBox="0 0 24 24"
												class="h-4 w-4"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<circle cx="6.5" cy="17.5" r="2.5" />
												<circle cx="17.5" cy="6.5" r="2.5" />
												<path d="M8.5 16l7-7" />
											</svg>
											{completedSessions.length}
										</span>
										<span class="inline-flex items-center gap-1.5">
											<svg
												viewBox="0 0 24 24"
												class="h-4 w-4"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path
													d="M7 4.5h7l3 3V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z"
												/>
												<path d="M14 4.5V8h3" />
											</svg>
											{certificates.length}
										</span>
									</div>
								</div>
							</div>

							<div class="flex items-center gap-2">
								<a
									href={resolve('/app?tab=route')}
									class="flex h-11 w-11 items-center justify-center border border-[var(--border)] bg-white text-[var(--muted)]"
									title="Back to route"
									aria-label="Back to route"
								>
									<svg
										viewBox="0 0 24 24"
										class="h-5 w-5"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<path d="M19 12H5" />
										<path d="m12 19-7-7 7-7" />
									</svg>
								</a>
								<button
									type="button"
									onclick={() => void loadDashboard()}
									class="flex h-11 w-11 items-center justify-center border border-[var(--border)] bg-white text-[var(--muted)]"
									title="Refresh"
									aria-label="Refresh"
								>
									<svg
										viewBox="0 0 24 24"
										class="h-5 w-5"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<path d="M21 12a9 9 0 1 1-2.64-6.36" />
										<path d="M21 3v6h-6" />
									</svg>
								</button>
							</div>
						</div>
					</header>

					{#if errorMessage}
						<div
							class="border border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]"
						>
							{errorMessage}
						</div>
					{/if}

					{#if loading}
						<div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
							{#each [0, 1] as loadingCard (loadingCard)}
								<div class="border border-[var(--border)] bg-[var(--surface)] p-4">
									<div class="h-4 w-20 bg-[var(--surface-muted)]"></div>
									<div class="mt-3 h-8 w-40 bg-[var(--surface-muted)]"></div>
									<div class="mt-4 h-24 bg-[var(--surface-muted)]"></div>
								</div>
							{/each}
						</div>
					{:else}
						<div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
							<section class="border border-[var(--border)] bg-[var(--surface)] p-4">
								<div
									class="mb-4 flex items-center justify-between gap-3 border-b border-[var(--border)] pb-3"
								>
									<div class="flex items-center gap-2">
										<svg
											viewBox="0 0 24 24"
											class="h-5 w-5 text-[var(--muted)]"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<circle cx="6.5" cy="17.5" r="2.5" />
											<circle cx="17.5" cy="6.5" r="2.5" />
											<path d="M8.5 16l7-7" />
										</svg>
										<p class="text-lg font-semibold text-[var(--text)]">Trips</p>
									</div>
									<span class="px-2 py-1 text-sm text-[var(--muted)]">{routeSessions.length}</span>
								</div>

								{#if routeSessions.length === 0}
									<div
										class="flex flex-col items-center justify-center gap-3 border border-dashed border-[var(--border)] px-4 py-12 text-center text-[var(--muted)]"
									>
										<svg
											viewBox="0 0 24 24"
											class="h-8 w-8"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<circle cx="6.5" cy="17.5" r="2.5" />
											<circle cx="17.5" cy="6.5" r="2.5" />
											<path d="M8.5 16l7-7" />
										</svg>
										<p>No trips</p>
									</div>
								{:else}
									<div class="space-y-3">
										{#each routeSessions as session (session._id)}
											<div class="border border-[var(--border)] bg-white p-4">
												<div class="flex items-start justify-between gap-3">
													<div class="min-w-0">
														<div class="flex items-center gap-2">
															<svg
																viewBox="0 0 24 24"
																class="h-4 w-4 text-[var(--muted)]"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																stroke-linecap="round"
																stroke-linejoin="round"
															>
																<path
																	d="M7 4.5h7l3 3V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z"
																/>
																<path d="M14 4.5V8h3" />
															</svg>
															<p class="text-base font-semibold text-[var(--text)]">
																Trip #{session._id.slice(-6)}
															</p>
															<span
																class={`px-2 py-1 text-[11px] font-semibold ${
																	session.arrivedAt
																		? 'bg-[#e8f7ee] text-[#20593b]'
																		: 'bg-[var(--surface-muted)] text-[var(--muted)]'
																}`}
															>
																{session.arrivedAt ? 'Done' : 'Live'}
															</span>
														</div>
														<p class="mt-2 text-sm text-[var(--muted)]">
															{formatDateTime(session.startedAt)}
														</p>
													</div>
													<div class="flex items-center gap-3 text-sm text-[var(--muted)]">
														<span class="inline-flex items-center gap-1.5">
															<svg
																viewBox="0 0 24 24"
																class="h-4 w-4"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																stroke-linecap="round"
																stroke-linejoin="round"
															>
																<circle cx="12" cy="12" r="8" />
																<path d="M12 8v4l2.5 2.5" />
															</svg>
															{formatMinutes(session.baselineEtaSec)}
														</span>
														<span class="inline-flex items-center gap-1.5">
															<svg
																viewBox="0 0 24 24"
																class="h-4 w-4"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																stroke-linecap="round"
																stroke-linejoin="round"
															>
																<path d="M4 12h16" />
																<path d="m13 5 7 7-7 7" />
															</svg>
															{session.locationSamplesCount}
														</span>
													</div>
												</div>

												<div class="mt-4 flex flex-wrap gap-2 text-sm text-[var(--muted)]">
													<span
														class="inline-flex items-center gap-1.5 border border-[var(--border)] px-2 py-1"
													>
														<svg
															viewBox="0 0 24 24"
															class="h-4 w-4"
															fill="none"
															stroke="currentColor"
															stroke-width="2"
															stroke-linecap="round"
															stroke-linejoin="round"
														>
															<path d="M12 21s6-4.35 6-10a6 6 0 1 0-12 0c0 5.65 6 10 6 10Z" />
															<circle cx="12" cy="11" r="2.5" />
														</svg>
														{Math.round(session.selectedRoute.distanceMeters / 1000)} km
													</span>
													<span
														class="inline-flex items-center gap-1.5 border border-[var(--border)] px-2 py-1"
													>
														<svg
															viewBox="0 0 24 24"
															class="h-4 w-4"
															fill="none"
															stroke="currentColor"
															stroke-width="2"
															stroke-linecap="round"
															stroke-linejoin="round"
														>
															<path d="M4 7h16" />
															<path d="M7 12h10" />
															<path d="M10 17h4" />
														</svg>
														{session.selectedRoute.explanationChips.length}
													</span>
													<span
														class="inline-flex items-center gap-1.5 border border-[var(--border)] px-2 py-1"
													>
														<svg
															viewBox="0 0 24 24"
															class="h-4 w-4"
															fill="none"
															stroke="currentColor"
															stroke-width="2"
															stroke-linecap="round"
															stroke-linejoin="round"
														>
															<path d="M12 9v4" />
															<path d="M12 17h.01" />
															<path
																d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
															/>
														</svg>
														{session.incidentIds.length}
													</span>
												</div>

												<div class="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
													<select
														bind:value={selectedUniversity[session._id]}
														class="w-full border border-[var(--border)] bg-white px-3 py-3 text-sm text-[var(--text)] outline-none"
													>
														{#each dashboard?.universities ?? [] as university (university.id)}
															<option value={university.id}>{university.shortName}</option>
														{/each}
													</select>

													<button
														type="button"
														onclick={() => createProof(session._id)}
														disabled={!session.arrivedAt || issuingFor === session._id}
														class="inline-flex items-center justify-center gap-2 border border-[var(--border)] bg-[var(--primary)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
													>
														<svg
															viewBox="0 0 24 24"
															class="h-4 w-4"
															fill="none"
															stroke="currentColor"
															stroke-width="2"
															stroke-linecap="round"
															stroke-linejoin="round"
														>
															<path d="M12 5v14" />
															<path d="M5 12h14" />
														</svg>
														{issuingFor === session._id ? '...' : 'Issue'}
													</button>
												</div>
											</div>
										{/each}
									</div>
								{/if}
							</section>

							<section class="border border-[var(--border)] bg-[var(--surface)] p-4">
								<div
									class="mb-4 flex items-center justify-between gap-3 border-b border-[var(--border)] pb-3"
								>
									<div class="flex items-center gap-2">
										<svg
											viewBox="0 0 24 24"
											class="h-5 w-5 text-[var(--muted)]"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="M7 4.5h7l3 3V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z" />
											<path d="M14 4.5V8h3" />
										</svg>
										<p class="text-lg font-semibold text-[var(--text)]">Certificates</p>
									</div>
									<span class="px-2 py-1 text-sm text-[var(--muted)]">{certificates.length}</span>
								</div>

								{#if certificates.length === 0}
									<div
										class="flex flex-col items-center justify-center gap-3 border border-dashed border-[var(--border)] px-4 py-16 text-center text-[var(--muted)]"
									>
										<svg
											viewBox="0 0 24 24"
											class="h-8 w-8"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="M7 4.5h7l3 3V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z" />
											<path d="M14 4.5V8h3" />
										</svg>
										<p>No certificates</p>
									</div>
								{:else}
									<div class="space-y-3">
										{#each certificates as certificate (certificate._id)}
											<div class="border border-[var(--border)] bg-white p-4">
												<div class="flex items-start justify-between gap-3">
													<div>
														<p class="text-base font-semibold text-[var(--text)]">
															{certificate.university.shortName}
														</p>
														<p class="mt-1 text-sm text-[var(--muted)]">
															{certificate.delayMinutes} min
														</p>
													</div>
													<div class="flex items-center gap-2">
														<a
															href={resolve(`/verify/${certificate.token}`)}
															class="flex h-10 w-10 items-center justify-center border border-[var(--border)] bg-white text-[var(--muted)]"
															title="Verify"
															aria-label="Verify"
														>
															<svg
																viewBox="0 0 24 24"
																class="h-4 w-4"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																stroke-linecap="round"
																stroke-linejoin="round"
															>
																<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
																<circle cx="12" cy="12" r="3" />
															</svg>
														</a>
														<a
															href={resolve(`/verify/${certificate.token}/certificate.pdf`)}
															class="flex h-10 w-10 items-center justify-center border border-[var(--border)] bg-[var(--primary)] text-white"
															title="PDF"
															aria-label="PDF"
														>
															<svg
																viewBox="0 0 24 24"
																class="h-4 w-4"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																stroke-linecap="round"
																stroke-linejoin="round"
															>
																<path d="M12 3v12" />
																<path d="m7 10 5 5 5-5" />
																<path d="M5 21h14" />
															</svg>
														</a>
													</div>
												</div>
												<p class="mt-3 text-sm text-[var(--muted)]">
													{formatDateTime(certificate.issuedAt)}
												</p>
											</div>
										{/each}
									</div>
								{/if}
							</section>
						</div>
					{/if}
				</main>
			</div>
		</div>
	</div>
{/if}
