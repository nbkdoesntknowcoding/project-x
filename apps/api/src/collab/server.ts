import { Logger } from '@hocuspocus/extension-logger';
import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';
import { config } from '../config/env.js';
import { authenticateConnection, type ConnectionContext } from './auth.js';
import { markdownToYjsState } from './markdown-bridge.js';
import { loadDocumentState, storeDocumentState } from './persistence.js';

const server = new Server<ConnectionContext>({
  port: config.COLLAB_PORT,
  address: '0.0.0.0',
  name: 'boppl-context-collab',
  // Research-anchored: 3s idle window, 15s ceiling under continuous typing.
  debounce: 3000,
  maxDebounce: 15000,
  // Disconnect peers idle for 30s — defends against half-open WS connections.
  timeout: 30000,
  extensions: [
    new Logger({
      onLoadDocument: true,
      onStoreDocument: true,
      onConnect: true,
      onDisconnect: true,
    }),
  ],

  async onAuthenticate(data) {
    const token = typeof data.token === 'string' ? data.token : '';
    if (!token) {
      throw new Error('Missing token');
    }
    return await authenticateConnection({
      token,
      documentName: data.documentName,
    });
  },

  async onLoadDocument(data) {
    const state = await loadDocumentState(data.context);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    return doc;
  },

  async onStoreDocument(data) {
    const ctx = data.lastContext;
    if (!ctx) return;
    const result = await storeDocumentState(ctx, data.document);
    if (result.snapshotted) {
      console.log(`[collab] Snapshot taken for ${ctx.doc_id} (50-store anchor)`);
    }
  },

  /**
   * Internal IPC for the api process's writeback path. The api and collab are
   * SEPARATE processes (per the deploy topology), so an in-process register
   * pattern can't work. Instead, the api POSTs to this endpoint with
   * X-Boppl-Internal-Secret = WORKOS_COOKIE_PASSWORD (the same shared secret
   * used by /api/_internal/set-session in 0.2). Auth scoping is the api's
   * responsibility — by the time we get here, the request is server-to-server.
   */
  async onRequest(data) {
    const url = data.request.url ?? '/';
    if (!url.startsWith('/_internal/writeback/')) {
      return;
    }
    if (data.request.method !== 'POST') {
      data.response.writeHead(405).end();
      throw null; // Hocuspocus contract: empty throw = "handled, skip default 404"
    }
    const secret = data.request.headers['x-boppl-internal-secret'];
    if (!secret || secret !== process.env.WORKOS_COOKIE_PASSWORD) {
      data.response.writeHead(403).end();
      throw null; // Hocuspocus contract: empty throw = "handled, skip default 404"
    }
    const docId = url.replace('/_internal/writeback/', '').split('?')[0] ?? '';
    if (!docId) {
      data.response.writeHead(400).end();
      throw null; // Hocuspocus contract: empty throw = "handled, skip default 404"
    }

    let body = '';
    for await (const chunk of data.request) {
      body += String(chunk);
    }
    const parsed = JSON.parse(body) as {
      markdown?: string;
      ctx?: ConnectionContext;
    };
    const markdown = parsed.markdown ?? '';

    if (!data.instance.documents.has(docId)) {
      data.response.writeHead(404, { 'content-type': 'application/json' });
      data.response.end(JSON.stringify({ applied: false, reason: 'no_live_doc' }));
      throw null; // Hocuspocus contract: empty throw = "handled, skip default 404"
    }

    // Pass a synthetic context so the next onStoreDocument has a lastContext
    // to scope the DB write through withTenant.
    const direct = await data.instance.openDirectConnection(docId, parsed.ctx);
    try {
      const newState = await markdownToYjsState(markdown);
      const incoming = new Y.Doc();
      Y.applyUpdate(incoming, newState);
      const incomingXml = incoming.getXmlFragment('prosemirror');
      const incomingItems = incomingXml.toArray();
      await direct.transact((live: Y.Doc) => {
        const xml = live.getXmlFragment('prosemirror');
        // REPLACE semantics for full-body writes (the only consumer in 1.2).
        // CRDT-merging the incoming state would keep the old nodes alongside
        // the new ones. Delete everything in the live fragment, then push
        // cloned items from the incoming fragment.
        if (xml.length > 0) xml.delete(0, xml.length);
        for (const item of incomingItems) {
          if (item instanceof Y.XmlElement || item instanceof Y.XmlText) {
            xml.push([item.clone()]);
          }
        }
      });
      data.response.writeHead(200, { 'content-type': 'application/json' });
      data.response.end(JSON.stringify({ applied: true }));
    } catch (err: unknown) {
      console.error('[collab] writeback failed', err);
      data.response.writeHead(500).end();
    } finally {
      await direct.disconnect();
    }
    // Throwing terminates Hocuspocus's onRequest chain — signals "handled".
    // The contract is THROW A FALSY VALUE: Hocuspocus's handler does
    // `if (error) throw error`, so a real Error gets re-thrown and crashes
    // the process. Use `throw null` so the "handled" signal is delivered
    // without triggering the upstream re-throw. (This regression killed
    // the collab process after every writeback when it was previously
    // `throw new Error('handled')` — see Phase 1.2 notes.)
    throw null;
  },
});

server
  .listen()
  .then(() => {
    console.log(`[collab] Hocuspocus listening on :${config.COLLAB_PORT}`);
  })
  .catch((err: unknown) => {
    console.error('[collab] Failed to start', err);
    process.exit(1);
  });

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[collab] ${signal} received — draining and shutting down`);
  try {
    const docs = server.hocuspocus.documents;
    for (const [name, doc] of docs.entries()) {
      const conn = doc.connections.entries().next();
      if (conn.done) continue;
      const ctx = conn.value[0].context as ConnectionContext | undefined;
      if (!ctx) continue;
      try {
        await storeDocumentState(ctx, doc);
        console.log(`[collab] drained ${name}`);
      } catch (err: unknown) {
        console.error(`[collab] drain failed for ${name}`, err);
      }
    }
  } finally {
    await server.destroy();
    process.exit(0);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
