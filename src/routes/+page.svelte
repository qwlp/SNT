<script lang="ts">
	import { resolve } from '$app/paths';
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { UNIVERSITY_SEEDS } from '$lib/domain/traffic';

	type BeforeInstallPromptEvent = Event & {
		prompt: () => Promise<void>;
		userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
	};

	let installPrompt = $state<BeforeInstallPromptEvent | null>(null);
	let installStatus = $state<'idle' | 'installed' | 'dismissed'>('idle');

	onMount(() => {
		if (!browser) return;

		const handleBeforeInstallPrompt = (event: Event) => {
			event.preventDefault();
			installPrompt = event as BeforeInstallPromptEvent;
		};

		window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

		return () => {
			window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
		};
	});

	const installApp = async () => {
		if (!installPrompt) return;

		await installPrompt.prompt();
		const choice = await installPrompt.userChoice;
		installStatus = choice.outcome === 'accepted' ? 'installed' : 'dismissed';
		installPrompt = null;
	};
</script>

<svelte:head>
	<title>SNT | Says No To Traffic</title>
</svelte:head>

<div class="min-h-screen bg-[var(--canvas)] text-[var(--text)]">
	<div class="mx-auto flex min-h-screen max-w-[1240px] flex-col px-4 py-6 sm:px-6 lg:px-8">
		<header
			class="flex flex-col gap-4 border-b border-[var(--border)] pb-5 sm:flex-row sm:items-end sm:justify-between"
		>
			<div>
				<p class="text-lg font-semibold">SNT</p>
				<p class="mt-1 text-sm text-[var(--muted)]">
					Incident reporting and route planning for Phnom Penh riders.
				</p>
			</div>
			<div class="flex flex-wrap gap-3">
				<button
					type="button"
					onclick={installApp}
					disabled={!installPrompt}
					class="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
				>
					{installPrompt
						? 'Install app'
						: installStatus === 'installed'
							? 'Installed'
							: 'Install when available'}
				</button>
				<a
					href={resolve('/app')}
					class="rounded-[8px] bg-[var(--primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[#5a4229]"
				>
					Open app
				</a>
			</div>
		</header>

		<main class="flex-1 py-8">
			<section
				class="grid gap-6 border-b border-[var(--border)] pb-8 lg:grid-cols-[minmax(0,1.1fr)_360px]"
			>
				<div class="space-y-6">
					<div>
						<h1 class="max-w-3xl text-4xl font-semibold sm:text-5xl">
							A practical commuter app for traffic reports and alternate routes.
						</h1>
						<p class="mt-4 max-w-2xl text-base leading-7 text-[var(--muted)] sm:text-lg">
							SNT is built around the daily Phnom Penh commute. Riders can report floods, VIP
							closures, and police checks, then compare motorbike-first route options with local
							context already applied.
						</p>
					</div>

					<div class="grid gap-4 md:grid-cols-2">
						<section
							class="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-soft)]"
						>
							<h2 class="text-base font-semibold">Report</h2>
							<p class="mt-2 text-sm leading-6 text-[var(--muted)]">
								Choose an incident type, add a short note, and publish it from your live location.
							</p>
						</section>
						<section
							class="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-soft)]"
						>
							<h2 class="text-base font-semibold">Route</h2>
							<p class="mt-2 text-sm leading-6 text-[var(--muted)]">
								Compare nearby options with shortcut bonuses and incident penalties already applied.
							</p>
						</section>
					</div>
				</div>

				<aside
					class="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)]"
				>
					<h2 class="text-lg font-semibold">Launch campuses</h2>
					<p class="mt-2 text-sm text-[var(--muted)]">
						The first rollout is scoped to three universities and a motorbike-heavy commuter base.
					</p>

					<div class="mt-5 divide-y divide-[var(--border)] border border-[var(--border)]">
						{#each UNIVERSITY_SEEDS as university (university.id)}
							<div class="grid gap-2 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_132px]">
								<div>
									<p class="text-sm font-medium text-[var(--text)]">{university.shortName}</p>
									<p class="mt-1 text-sm text-[var(--muted)]">{university.name}</p>
								</div>
								<div class="text-sm text-[var(--muted)] sm:text-right">
									<p>{university.targetUsers.toLocaleString()} riders</p>
									<p>{university.repTarget} campus reps</p>
								</div>
							</div>
						{/each}
					</div>
				</aside>
			</section>

			<section class="grid gap-6 py-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<div>
					<h2 class="text-2xl font-semibold">How the workflow stays strict</h2>
					<ol class="mt-4 space-y-3 text-sm leading-6 text-[var(--muted)]">
						<li class="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
							1. Reports are tied to a real location and can be confirmed by other riders.
						</li>
						<li class="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
							2. Route planning starts from the current position and keeps the selected trip under
							tracking.
						</li>
						<li class="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
							3. Active incidents are time-boxed so stale reports do not linger in the feed.
						</li>
					</ol>
				</div>

				<div>
					<h2 class="text-2xl font-semibold">What the pilot covers</h2>
					<div
						class="mt-4 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)]"
					>
						<ul class="space-y-3 text-sm leading-6 text-[var(--muted)]">
							<li>Phnom Penh only, with routing tuned for campus corridors and alley shortcuts.</li>
							<li>English-first interface with Khmer labels where riders need to move quickly.</li>
							<li>PWA install support so the app can live on the home screen during the pilot.</li>
						</ul>
					</div>
				</div>
			</section>
		</main>

		<footer
			class="border-t border-[var(--border)] pt-5 text-sm text-[var(--muted)] sm:flex sm:items-center sm:justify-between"
		>
			<p>Phnom Penh pilot for RUPP, ITC, and NUM.</p>
			<p class="mt-2 sm:mt-0">Motorbike routes and incident reports in one app.</p>
		</footer>
	</div>
</div>
