<script lang="ts">
	import './layout.css';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href="/favicon.ico" sizes="any" />
	<link rel="manifest" href="/manifest.webmanifest" />
	<meta name="theme-color" content="#f4f7fb" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
</svelte:head>
{@render children()}
