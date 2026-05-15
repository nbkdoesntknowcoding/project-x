import { WorkOS } from '@workos-inc/node';

const apiKey = import.meta.env.WORKOS_API_KEY as string | undefined;
const clientId = import.meta.env.WORKOS_CLIENT_ID as string | undefined;

if (!apiKey || !clientId) {
  throw new Error(
    'WORKOS_API_KEY and WORKOS_CLIENT_ID must be set in the web environment',
  );
}

export const workos = new WorkOS(apiKey, { clientId });
