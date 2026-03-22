<script lang="ts">
	import { isHttpError } from '@sveltejs/kit';

	const { error }: { error: unknown } = $props();

	const parsedError = $derived.by((): App.Error => {
		if (isHttpError(error)) {
			return error.body;
		}

		console.error(error);

		return {
			message: 'Unknown error',
			kind: 'UnknownError',
			timestamp: Date.now()
		};
	});
</script>

<div class="min-h-screen bg-[var(--canvas)] px-4 py-8 text-[var(--text)]">
	<div
		class="mx-auto max-w-2xl rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-soft)]"
	>
		<h1 class="text-3xl font-semibold">{parsedError.message}</h1>
		<p class="mt-3 text-sm text-[var(--muted)]">Error type: {parsedError.kind}</p>
		<p class="mt-1 text-sm text-[var(--muted)]">Timestamp: {parsedError.timestamp}</p>
		{#if parsedError.traceId}
			<p
				class="mt-4 rounded-[8px] border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-3 text-sm text-[var(--text)]"
			>
				Support reference: {parsedError.traceId}
			</p>
		{/if}
	</div>
</div>
