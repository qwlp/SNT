import { Clerk } from '@clerk/clerk-js';
import { env } from '$env/dynamic/public';
import { createGuestSession } from '$lib/remote/auth.remote';
import { createContext, onMount } from 'svelte';
import { ui } from '@clerk/ui';

type EmittedOrganization = NonNullable<
	Parameters<Parameters<Clerk['addListener']>[0]>[0]['organization']
>;
type EmittedUser = NonNullable<Parameters<Parameters<Clerk['addListener']>[0]>[0]['user']>;
type EmittedSession = NonNullable<Parameters<Parameters<Clerk['addListener']>[0]>[0]['session']>;

const resolveClerkPublishableKey = () =>
	env.PUBLIC_CLERK_PUBLISHABLE_KEY ??
	(
		globalThis as typeof globalThis & {
			__sveltekit_dev?: { env?: Record<string, string> };
		}
	).__sveltekit_dev?.env?.PUBLIC_CLERK_PUBLISHABLE_KEY ??
	import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY ??
	import.meta.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
	'';

class ClerkStore {
	isClerkLoaded = $state(false);
	clerk: Clerk;
	isBootstrappingGuest = $state(false);
	guestBootstrapFailed = $state<string | null>(null);
	currentOrganization = $state<EmittedOrganization | null>(null);
	currentSession = $state<EmittedSession | null>(null);
	currentUser = $state<EmittedUser | null>(null);

	constructor() {
		this.clerk = new Clerk(resolveClerkPublishableKey());

		$effect(() => {
			const cleanup = this.clerk.addListener((emission) => {
				if (emission.organization) {
					this.currentOrganization = emission.organization;
				} else {
					this.currentOrganization = null;
				}

				if (emission.session) {
					this.currentSession = emission.session;
				} else {
					this.currentSession = null;
				}

				if (emission.user) {
					this.currentUser = emission.user;
				} else {
					this.currentUser = null;
				}
			});

			return () => {
				cleanup();
			};
		});

		$effect(() => {
			if (
				!this.isClerkLoaded ||
				this.currentSession ||
				this.currentUser ||
				this.isBootstrappingGuest ||
				this.guestBootstrapFailed
			) {
				return;
			}

			void this.ensureGuestSession();
		});

		onMount(async () => {
			try {
				await this.clerk.load({
					ui,
					afterSignOutUrl: '/app',
					signInForceRedirectUrl: '/app',
					signUpForceRedirectUrl: '/app'
				});

				await this.ensureGuestSession();
				this.isClerkLoaded = true;
			} catch (error) {
				console.error('Error loading Clerk', error);
			} finally {
				this.isClerkLoaded = true;
			}
		});
	}

	private async ensureGuestSession() {
		if (this.currentSession || this.currentUser || this.isBootstrappingGuest) {
			return;
		}

		this.isBootstrappingGuest = true;
		this.guestBootstrapFailed = null;

		try {
			const ticket = await createGuestSession({});
			const signIn = await this.clerk.client?.signIn.create({
				strategy: 'ticket',
				ticket
			});

			if (!signIn?.createdSessionId) {
				throw new Error('Clerk did not return a session for the guest sign-in ticket.');
			}

			await this.clerk.setActive({
				session: signIn.createdSessionId
			});
		} catch (error) {
			this.guestBootstrapFailed =
				error instanceof Error ? error.message : 'Unable to start the anonymous demo session.';
			console.error('Error starting guest session', error);
		} finally {
			this.isBootstrappingGuest = false;
		}
	}
}

const [internalGetClerkContext, setInternalGetClerkContext] = createContext<ClerkStore>();

export function getClerkContext() {
	const clerkContext = internalGetClerkContext();

	if (!clerkContext) {
		throw new Error('Clerk context not found');
	}

	return clerkContext;
}

export function setClerkContext() {
	const clerkContext = new ClerkStore();
	setInternalGetClerkContext(clerkContext);
	return clerkContext;
}
