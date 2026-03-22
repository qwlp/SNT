<script lang="ts">
	import { resolve } from '$app/paths';

	type AppSection = 'pulse' | 'route' | 'proof' | 'account';

	interface SummaryItem {
		label: string;
		value: string;
	}

	let {
		active,
		summary = []
	}: {
		active: AppSection;
		summary?: SummaryItem[];
	} = $props();

	type NavPath = '/app?tab=pulse' | '/app?tab=route' | '/app/proof' | '/app?tab=account';

	const navItems: Array<{ id: AppSection; label: string; path: NavPath }> = [
		{ id: 'pulse', label: 'Report', path: '/app?tab=pulse' },
		{ id: 'route', label: 'Route', path: '/app?tab=route' },
		{ id: 'proof', label: 'Proof', path: '/app/proof' },
		{ id: 'account', label: 'Account', path: '/app?tab=account' }
	];
</script>

<div class="space-y-3">
	<aside
		class="hidden border border-[var(--border)] bg-white/95 p-4 shadow-[var(--shadow-soft)] backdrop-blur-xl lg:flex lg:min-h-[calc(100vh-2rem)] lg:w-[220px] lg:flex-col lg:justify-between"
	>
		<div class="space-y-3">
			<p class="text-sm font-semibold tracking-[0.28em] text-[var(--muted)] uppercase">SNT</p>

			<nav class="space-y-2">
				{#each navItems as item (item.id)}
					<a
						href={resolve(item.path)}
						aria-current={active === item.id ? 'page' : undefined}
						class={`flex items-center gap-3 border px-3 py-3 transition ${
							active === item.id
								? 'border-[#1e88f7] bg-[#eef6ff] text-[#141414] shadow-[0_10px_24px_rgba(30,136,247,0.12)]'
								: 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:border-[#1e88f7]/40 hover:text-[var(--text)]'
						}`}
					>
						<span
							class={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border ${
								active === item.id
									? 'border-[#1e88f7] bg-white text-[#1e88f7]'
									: 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--muted)]'
							}`}
						>
							{#if item.id === 'pulse'}
								<svg
									viewBox="0 0 24 24"
									class="h-5 w-5"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path d="M12 3v18" />
									<path d="M3 12h18" />
								</svg>
							{:else if item.id === 'route'}
								<svg
									viewBox="0 0 24 24"
									class="h-5 w-5"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<circle cx="6.5" cy="17.5" r="2.5" />
									<circle cx="17.5" cy="6.5" r="2.5" />
									<path d="M8.5 16l7-7" />
									<path d="M10.5 6h4.5v4.5" />
								</svg>
							{:else if item.id === 'proof'}
								<svg
									viewBox="0 0 24 24"
									class="h-5 w-5"
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
							{:else}
								<svg
									viewBox="0 0 24 24"
									class="h-5 w-5"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<circle cx="12" cy="8" r="3.5" />
									<path d="M5 19a7 7 0 0 1 14 0" />
								</svg>
							{/if}
						</span>
						<span class="text-base font-semibold">{item.label}</span>
					</a>
				{/each}
			</nav>
		</div>

		{#if summary.length}
			<div class="grid gap-2 border-t border-[var(--border)] pt-3">
				{#each summary.slice(0, 2) as item (`${item.label}-${item.value}`)}
					<div
						class="rounded-[18px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-[var(--shadow-soft)]"
					>
						<p class="text-[11px] tracking-[0.22em] text-[var(--muted)] uppercase">{item.label}</p>
						<p class="mt-1 text-xl font-semibold text-[var(--text)]">{item.value}</p>
					</div>
				{/each}
			</div>
		{/if}
	</aside>

	<div class="space-y-3 lg:hidden">
		<nav
			class="border border-[var(--border)] bg-white/95 p-2 shadow-[var(--shadow-soft)] backdrop-blur-xl"
		>
			<div class="grid grid-cols-4 gap-2">
				{#each navItems as item (item.id)}
					<a
						href={resolve(item.path)}
						aria-current={active === item.id ? 'page' : undefined}
						class={`flex min-h-[68px] flex-col items-center justify-center gap-2 border px-2 py-2 text-center transition ${
							active === item.id
								? 'border-[#1e88f7] bg-[#eef6ff] text-[#141414]'
								: 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)]'
						}`}
					>
						<span
							class={`flex h-8 w-8 items-center justify-center ${
								active === item.id ? 'text-[#1e88f7]' : 'text-[var(--muted)]'
							}`}
						>
							{#if item.id === 'pulse'}
								<svg
									viewBox="0 0 24 24"
									class="h-4 w-4"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path d="M12 3v18" />
									<path d="M3 12h18" />
								</svg>
							{:else if item.id === 'route'}
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
									<path d="M10.5 6h4.5v4.5" />
								</svg>
							{:else if item.id === 'proof'}
								<svg
									viewBox="0 0 24 24"
									class="h-4 w-4"
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
							{:else}
								<svg
									viewBox="0 0 24 24"
									class="h-4 w-4"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<circle cx="12" cy="8" r="3.5" />
									<path d="M5 19a7 7 0 0 1 14 0" />
								</svg>
							{/if}
						</span>
						<span class="text-sm font-semibold">{item.label}</span>
					</a>
				{/each}
			</div>
		</nav>

		{#if summary.length}
			<div class="grid grid-cols-2 gap-2">
				{#each summary.slice(0, 2) as item (`mobile-${item.label}-${item.value}`)}
					<div
						class="rounded-[18px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-[var(--shadow-soft)]"
					>
						<p class="text-[11px] tracking-[0.24em] text-[var(--muted)] uppercase">{item.label}</p>
						<p class="mt-1 text-xl font-semibold text-[var(--text)]">{item.value}</p>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
