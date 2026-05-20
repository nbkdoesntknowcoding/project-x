/// <reference types="astro/client" />

import type { SessionData as BopplSessionData } from '@boppl/shared';

declare global {
  namespace App {
    interface Locals {
      auth?: BopplSessionData;
    }
  }
}

interface ImportMetaEnv {
  readonly WORKOS_API_KEY: string;
  readonly WORKOS_CLIENT_ID: string;
  readonly WORKOS_REDIRECT_URI: string;
  readonly WORKOS_COOKIE_PASSWORD: string;
  readonly PUBLIC_API_URL: string;
  /** Public HTTPS URL of the MCP endpoint root (without /mcp suffix).
   *  Defaults to PUBLIC_API_URL. Override to a Cloudflare Tunnel or other
   *  public URL so the connection-page config snippet shows a reachable URL
   *  even when PUBLIC_API_URL is still localhost for direct SSR calls. */
  readonly PUBLIC_MCP_URL?: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export {};
