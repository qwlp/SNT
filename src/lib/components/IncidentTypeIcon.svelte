<script lang="ts">
	import type { IncidentType } from '$lib/domain/traffic';

	let { type, class: className = 'h-11 w-11' } = $props<{
		type: IncidentType;
		class?: string;
	}>();
</script>

{#if type === 'roadblock'}
	<svg viewBox="0 0 64 64" class={className} aria-hidden="true">
		<path
			d="M32 8 54 49.5A4 4 0 0 1 50.5 55h-37A4 4 0 0 1 10 49.5L32 8Z"
			fill="#FFD54A"
			stroke="#141414"
			stroke-width="3.5"
			stroke-linejoin="round"
		/>
		<path d="M32 23v13" stroke="#141414" stroke-width="4.5" stroke-linecap="round" />
		<circle cx="32" cy="43" r="3.2" fill="#141414" />
	</svg>
{:else if type === 'vip'}
	<svg viewBox="0 0 64 64" class={className} aria-hidden="true">
		<path
			d="m13 45 5-20 14 10 14-10 5 20H13Z"
			fill="#FFD451"
			stroke="#141414"
			stroke-width="3.5"
			stroke-linejoin="round"
		/>
		<path
			d="M18 25 11.5 17l10 2.5L32 11l10.5 8.5 10-2.5L46 25"
			fill="#FFE389"
			stroke="#141414"
			stroke-width="3.5"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		<path d="M19 50h26" stroke="#141414" stroke-width="3.5" stroke-linecap="round" />
	</svg>
{:else if type === 'wedding'}
	<svg viewBox="0 0 64 64" class={className} aria-hidden="true">
		<circle cx="24" cy="35" r="11" fill="#FFC8DA" stroke="#141414" stroke-width="3.5" />
		<circle cx="40" cy="35" r="11" fill="#FFE3A6" stroke="#141414" stroke-width="3.5" />
		<path
			d="M32 16c1.7-3.4 6.7-5.4 10.2-2.1 3.1 2.9 2.9 7.6-.3 10.4L32 34l-9.9-9.7c-3.2-2.8-3.4-7.5-.3-10.4C25.3 10.6 30.3 12.6 32 16Z"
			fill="#FF6B81"
			stroke="#141414"
			stroke-width="3"
			stroke-linejoin="round"
		/>
	</svg>
{:else if type === 'flood'}
	<svg viewBox="0 0 64 64" class={className} aria-hidden="true">
		<path
			d="M32 11c7.4 8.7 14 16.1 14 23.1A14 14 0 1 1 18 34.1C18 27.1 24.6 19.7 32 11Z"
			fill="#6EC8FF"
			stroke="#141414"
			stroke-width="3.5"
			stroke-linejoin="round"
		/>
		<path
			d="M15 47c3 2.5 6 2.5 9 0s6-2.5 9 0 6 2.5 9 0 6-2.5 9 0"
			stroke="#141414"
			stroke-width="3.5"
			stroke-linecap="round"
		/>
		<path
			d="M19 55c3 2.5 6 2.5 9 0s6-2.5 9 0 6 2.5 9 0"
			stroke="#141414"
			stroke-width="3.5"
			stroke-linecap="round"
		/>
	</svg>
{:else if type === 'accident'}
	<svg viewBox="0 0 64 64" class={className} aria-hidden="true">
		<path
			d="m20 37 5-9 8-2 5 2 4 9v7H16v-4l4-3Z"
			fill="#FF8A3D"
			stroke="#141414"
			stroke-width="3.5"
			stroke-linejoin="round"
		/>
		<path
			d="m33 40 6-8 8-1 5 3 2 7-3 3H33v-4Z"
			fill="#FF5D5D"
			stroke="#141414"
			stroke-width="3.5"
			stroke-linejoin="round"
		/>
		<circle cx="24" cy="45" r="3.5" fill="#141414" />
		<circle cx="36" cy="45" r="3.5" fill="#141414" />
		<circle cx="42" cy="45" r="3.5" fill="#141414" />
		<circle cx="50" cy="45" r="3.5" fill="#141414" />
		<path
			d="m32 14 2.8 5.7 6.2.9-4.5 4.3 1.1 6.1-5.6-3-5.6 3 1.1-6.1-4.5-4.3 6.2-.9L32 14Z"
			fill="#FFE066"
			stroke="#141414"
			stroke-width="3"
			stroke-linejoin="round"
		/>
	</svg>
{:else}
	<svg viewBox="0 0 64 64" class={className} aria-hidden="true">
		<path
			d="M32 10 48 16v11c0 11.3-6.5 21-16 27-9.5-6-16-15.7-16-27V16l16-6Z"
			fill="#7AB8FF"
			stroke="#141414"
			stroke-width="3.5"
			stroke-linejoin="round"
		/>
		<path
			d="M32 21.5 34.6 27l6 .9-4.3 4.2 1 6-5.3-2.9-5.3 2.9 1-6-4.3-4.2 6-.9L32 21.5Z"
			fill="#FFE373"
			stroke="#141414"
			stroke-width="3"
			stroke-linejoin="round"
		/>
	</svg>
{/if}
