/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as authed_helpers from '../authed/helpers.js';
import type * as authed_incidents from '../authed/incidents.js';
import type * as authed_routes from '../authed/routes.js';
import type * as authed_shortcuts from '../authed/shortcuts.js';
import type * as authed_users from '../authed/users.js';
import type * as private_helpers from '../private/helpers.js';
import type * as private_incidents from '../private/incidents.js';
import type * as private_proofs from '../private/proofs.js';
import type * as private_routes from '../private/routes.js';
import type * as private_shortcuts from '../private/shortcuts.js';
import type * as private_users from '../private/users.js';

import type { ApiFromModules, FilterApi, FunctionReference } from 'convex/server';

declare const fullApi: ApiFromModules<{
	'authed/helpers': typeof authed_helpers;
	'authed/incidents': typeof authed_incidents;
	'authed/routes': typeof authed_routes;
	'authed/shortcuts': typeof authed_shortcuts;
	'authed/users': typeof authed_users;
	'private/helpers': typeof private_helpers;
	'private/incidents': typeof private_incidents;
	'private/proofs': typeof private_proofs;
	'private/routes': typeof private_routes;
	'private/shortcuts': typeof private_shortcuts;
	'private/users': typeof private_users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, 'public'>>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, 'internal'>>;

export declare const components: {};
