<script lang="ts">
	import { resolve } from '$app/paths';

	let { data } = $props();
</script>

<svelte:head>
	<title>SNT Verification</title>
</svelte:head>

<div class="min-h-screen bg-[var(--canvas)] px-4 py-8 text-[var(--text)]">
	<div class="mx-auto max-w-4xl">
		<header class="border-b border-[var(--border)] pb-5">
			<p class="text-lg font-semibold">SNT verification</p>
			<p class="mt-1 text-sm text-[var(--muted)]">
				Public validation for a traffic delay certificate issued from a tracked trip.
			</p>
		</header>

		<section
			class="mt-6 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-soft)]"
		>
			{#if !data.payload}
				<div class="px-6 py-8">
					<h1 class="text-3xl font-semibold">Certificate not found</h1>
					<p class="mt-3 max-w-2xl text-sm leading-6 text-[var(--muted)]">
						This token is unknown, revoked, or no longer available in the verification service.
					</p>
				</div>
			{:else}
				<div class="border-b border-[var(--border)] px-6 py-5">
					<h1 class="text-3xl font-semibold">
						{data.payload.certificate.status === 'valid'
							? 'Valid delay certificate'
							: 'Revoked delay certificate'}
					</h1>
					<p class="mt-3 text-sm text-[var(--muted)]">
						{data.payload.university.name} • issued {new Date(
							data.payload.certificate.issuedAt
						).toLocaleString('en-US')}
					</p>
				</div>

				<div class="grid gap-4 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_300px]">
					<div class="space-y-4">
						<section class="rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
							<div class="border-b border-[var(--border)] px-4 py-3">
								<h2 class="text-lg font-semibold">Certificate details</h2>
							</div>
							<dl class="divide-y divide-[var(--border)] text-sm">
								<div class="flex items-start justify-between gap-4 px-4 py-3">
									<dt class="text-[var(--muted)]">Student</dt>
									<dd class="text-right font-medium text-[var(--text)]">
										{data.payload.user?.displayName ?? 'Unknown rider'}
									</dd>
								</div>
								<div class="flex items-start justify-between gap-4 px-4 py-3">
									<dt class="text-[var(--muted)]">Delay</dt>
									<dd class="text-right font-medium text-[var(--text)]">
										{data.payload.certificate.delayMinutes} minutes
									</dd>
								</div>
								<div class="flex items-start justify-between gap-4 px-4 py-3">
									<dt class="text-[var(--muted)]">Status</dt>
									<dd class="text-right font-medium text-[var(--text)]">
										{data.payload.certificate.status}
									</dd>
								</div>
								<div class="flex items-start justify-between gap-4 px-4 py-3">
									<dt class="text-[var(--muted)]">Token</dt>
									<dd class="text-right font-medium text-[var(--text)]">
										{data.payload.certificate.token}
									</dd>
								</div>
							</dl>
						</section>

						<section class="rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
							<div class="border-b border-[var(--border)] px-4 py-3">
								<h2 class="text-lg font-semibold">Evidence summary</h2>
							</div>
							<ul class="space-y-3 px-4 py-4 text-sm leading-6 text-[var(--muted)]">
								{#each data.payload.certificate.evidenceSummary as line (`evidence-${line}`)}
									<li>{line}</li>
								{/each}
							</ul>
						</section>
					</div>

					<aside class="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-4 py-4">
						<h2 class="text-lg font-semibold">Actions</h2>
						<div class="mt-4 space-y-3">
							<a
								href={resolve(`/verify/${data.payload.certificate.token}/certificate.pdf`)}
								class="block rounded-[8px] bg-[var(--primary)] px-4 py-3 text-center text-sm font-medium text-white hover:bg-[#5a4229]"
							>
								Download PDF
							</a>
							<a
								href={resolve('/app')}
								class="block rounded-[8px] border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-center text-sm font-medium text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--primary-soft)]"
							>
								Open SNT app
							</a>
						</div>
					</aside>
				</div>
			{/if}
		</section>
	</div>
</div>
