/**
 * Xget - High-performance acceleration engine for developer resources
 * Copyright (C) Xi Xu
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { handleRequest } from '../src/app/handle-request.js';

const ACCESS_POLICY_ENV = 'XGET_ALLOWED_CLIENT_IPS';

/**
 * Reads the immutable client IP supplied by the EdgeOne runtime.
 * @param {Request} request - Incoming EdgeOne request.
 * @returns {string} Client IP or an empty string outside EdgeOne.
 */
function getEdgeOneClientIp(request) {
  const edgeOneMetadata = Reflect.get(request, 'eo');
  if (!edgeOneMetadata || typeof edgeOneMetadata !== 'object') {
    return '';
  }

  const clientIp = Reflect.get(edgeOneMetadata, 'clientIp');
  return typeof clientIp === 'string' ? clientIp.trim() : '';
}

/**
 * Enforces a fail-closed IP allowlist for the private EdgeOne deployment.
 * @param {Request} request - Incoming EdgeOne request.
 * @param {Record<string, unknown>} env - Runtime environment variables.
 * @returns {{ allowed: boolean, status: 403 | 503 }} Access decision.
 */
function checkClientAccess(request, env) {
  const rawAllowedIps = env[ACCESS_POLICY_ENV];
  if (typeof rawAllowedIps !== 'string' || rawAllowedIps.trim() === '') {
    return { allowed: false, status: 503 };
  }

  const allowedIps = new Set(
    rawAllowedIps
      .split(',')
      .map(ip => ip.trim())
      .filter(Boolean)
  );
  const clientIp = getEdgeOneClientIp(request);

  return { allowed: allowedIps.has(clientIp), status: 403 };
}

/**
 * Creates a non-cacheable access-policy response.
 * @param {403 | 503} status - HTTP response status.
 * @returns {Response} Denied response.
 */
function createAccessPolicyResponse(status) {
  return new Response(status === 503 ? 'Access policy is not configured' : 'Forbidden', {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8'
    }
  });
}

/**
 * @typedef {{
 *   request: Request,
 *   env: Record<string, unknown>,
 *   params: object,
 *   waitUntil: (promise: Promise<unknown>) => void,
 *   next: () => Promise<Response>,
 *   data: object
 * }} PagesFunctionContext
 */

/**
 * Pages Function handler for all routes.
 *
 * This catch-all route handler processes all incoming requests to the Xget
 * acceleration engine. It delegates request processing to the main handleRequest
 * function from the Workers code, maintaining full compatibility with the
 * existing implementation.
 *
 * The [[path]] syntax in the filename creates a catch-all route that matches
 * any path, allowing this single function to handle all requests to the Pages
 * application.
 * @param {PagesFunctionContext} context - Pages Function context
 * @returns {Promise<Response>} The HTTP response to return to the client
 * @example
 * // This is called automatically by Pages
 * // Runtime invokes: onRequest(context)
 * // Returns: Response with package data
 * @example
 * // Environment variables usage
 * // wrangler.toml: [vars] TIMEOUT_SECONDS = "60"
 * // context.env contains: { TIMEOUT_SECONDS: "60" }
 * // handleRequest uses createConfig(env) to override defaults
 */
export async function onRequest(context) {
  // Extract request, env, and create an execution context compatible with Workers
  const { request, env, waitUntil } = context;
  const access = checkClientAccess(request, env);
  if (!access.allowed) {
    return createAccessPolicyResponse(access.status);
  }

  // Create a minimal ExecutionContext-like object for compatibility
  const ctx = {
    waitUntil,
    passThroughOnException: () => {
      // Pages doesn't support passThroughOnException, so this is a no-op
      console.warn('passThroughOnException is not supported in Pages Functions');
    }
  };

  // Delegate to the main request handler
  return handleRequest(request, env, ctx);
}
