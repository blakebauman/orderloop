/**
 * The REST API's OpenAPI document, built from the web app's own source (the zod schemas its
 * handlers validate with), so the explorer at /api/ matches the code at this commit. The live
 * deployment serves the same document at https://orderloop.app/api/v1/openapi.json.
 */

import type { APIRoute } from 'astro';
import { openApiDocument } from '../../../web/app/lib/openapi';

export const prerender = true;

export const GET: APIRoute = () => Response.json(openApiDocument('https://orderloop.app'));
