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
		{ id: 'pulse', label: 'Pulse', path: '/app?tab=pulse' },
		{ id: 'route', label: 'Route', path: '/app?tab=route' },
		{ id: 'proof', label: 'Proof', path: '/app/proof' },
		{ id: 'account', label: 'Account', path: '/app?tab=account' }
	];
</script>

<div class="space-y-4">
	<aside
		class="hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[0_2px_8px_rgba(36,31,23,0.08)] lg:flex lg:min-h-[calc(100vh-2rem)] lg:flex-col lg:justify-between"
	>
		<div>
			<a href={resolve('/app')} class="text-lg font-semibold text-[var(--text)]">SNT</a>
			<p class="mt-1 text-sm text-[var(--muted)]">Phnom Penh commuter tools</p>

			<nav class="mt-6 space-y-1">
				{#each navItems as item (item.id)}
					<a
						href={resolve(item.path)}
						aria-current={active === item.id ? 'page' : undefined}
						class={`block rounded-[8px] border px-3 py-2 text-sm font-medium ${
							active === item.id
								? 'border-[var(--border-strong)] bg-[var(--surface-muted)] text-[var(--text)]'
								: 'border-transparent text-[var(--muted)] hover:border-[var(--border)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]'
						}`}
					>
						{item.label}
					</a>
				{/each}
			</nav>
		</div>

		{#if summary.length}
			<dl class="space-y-3 border-t border-[var(--border)] pt-4">
				{#each summary as item (`${item.label}-${item.value}`)}
					<div class="flex items-start justify-between gap-3 text-sm">
						<dt class="text-[var(--muted)]">{item.label}</dt>
						<dd class="text-right font-medium text-[var(--text)]">{item.value}</dd>
					</div>
				{/each}
			</dl>
		{/if}
	</aside>

	<nav
		class="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[0_2px_8px_rgba(36,31,23,0.08)] lg:hidden"
	>
		<div class="grid grid-cols-4 gap-1">
			{#each navItems as item (item.id)}
				<a
					href={resolve(item.path)}
					aria-current={active === item.id ? 'page' : undefined}
					class={`rounded-[8px] px-3 py-2 text-center text-sm font-medium ${
						active === item.id
							? 'bg-[var(--surface-muted)] text-[var(--text)]'
							: 'text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]'
					}`}
				>
					{item.label}
				</a>
			{/each}
		</div>

		{#if summary.length}
			<div class="mt-3 flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
				{#each summary as item (`mobile-${item.label}-${item.value}`)}
					<div class="rounded-[8px] bg-[var(--surface-muted)] px-3 py-2 text-sm">
						<p class="text-[var(--muted)]">{item.label}</p>
						<p class="font-medium text-[var(--text)]">{item.value}</p>
					</div>
				{/each}
			</div>
		{/if}
	</nav>
</div>
