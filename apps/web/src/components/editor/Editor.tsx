import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { type JSX, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import './editor.css';
import { ConnectionStatus } from './ConnectionStatus';
import { mathPlugin } from './plugins/math';
import { configureMermaidPreview } from './plugins/mermaid';

interface EditorProps {
  docId: string;
  initialMarkdown: string;
  jwt: string;
  user: { id: string; email: string };
  collabUrl?: string;
}

const USER_COLOR_PALETTE: readonly string[] = [
  '#8b78f0',
  '#22c55e',
  '#f59e0b',
  '#3b82f6',
  '#ef4444',
  '#a855f7',
  '#ec4899',
  '#06b6d4',
];

function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return USER_COLOR_PALETTE[hash % USER_COLOR_PALETTE.length] ?? '#8b78f0';
}

export function Editor({
  docId,
  initialMarkdown,
  jwt,
  user,
  collabUrl,
}: EditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const ydoc = new Y.Doc();

    const url =
      collabUrl ??
      ((import.meta.env.PUBLIC_COLLAB_URL as string | undefined) ?? 'ws://localhost:1234');

    const hp = new HocuspocusProvider({
      url,
      name: docId,
      document: ydoc,
      token: jwt,
    });

    hp.setAwarenessField('user', {
      id: user.id,
      name: user.email,
      color: colorForUser(user.id),
    });

    setProvider(hp);

    // Crepe starts EMPTY. The Y.Doc binding owns content. Either:
    //   (a) Y.Doc loads non-empty from server → bindDoc syncs it into PM, OR
    //   (b) Y.Doc loads empty → applyTemplate seeds it from initialMarkdown.
    // Passing initialMarkdown as Crepe's defaultValue produces doubled content
    // because both PM and applyTemplate try to seed.
    const crepe = new Crepe({
      root,
      defaultValue: '',
      features: {
        [Crepe.Feature.BlockEdit]: true,
        [Crepe.Feature.CodeMirror]: true,
        [Crepe.Feature.ImageBlock]: true,
        [Crepe.Feature.LinkTooltip]: true,
        [Crepe.Feature.ListItem]: true,
        [Crepe.Feature.Placeholder]: true,
        [Crepe.Feature.Table]: true,
        [Crepe.Feature.Toolbar]: true,
        [Crepe.Feature.Cursor]: true,
        // Replaced by our plugins/math.tsx — must be explicit (Crepe defaults Latex to true).
        [Crepe.Feature.Latex]: false,
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: 'Type / to insert a block' },
      },
    });

    crepe.editor.use(mathPlugin);
    crepe.editor.config(configureMermaidPreview);
    crepe.editor.use(collab);

    let disposed = false;
    crepe
      .create()
      .then(() => {
        if (disposed) return;
        crepe.editor.action((ctx) => {
          // Bind + connect first; defer the template seed until AFTER the
          // server's synced event. Calling applyTemplate before the initial
          // sync arrives races with the server-loaded Y.Doc and produces
          // doubled content.
          const collabService = ctx.get(collabServiceCtx);
          collabService.bindDoc(ydoc).setAwareness(hp.awareness!).connect();

          const seedIfEmpty = (): void => {
            const xml = ydoc.getXmlFragment('prosemirror');
            if (xml.length === 0 && initialMarkdown.trim().length > 0) {
              collabService.applyTemplate(initialMarkdown, () => true);
            }
          };
          // synced fires after the server's initial state has been applied.
          if (hp.isSynced) {
            seedIfEmpty();
          } else {
            hp.on('synced', seedIfEmpty);
          }
        });
      })
      .catch((err: unknown) => {
        console.error('Crepe init failed', err);
      });

    return () => {
      disposed = true;
      void crepe.destroy();
      hp.destroy();
      ydoc.destroy();
      setProvider(null);
    };
    // Mount-once: docId/jwt/user changes during a session would require a full
    // teardown anyway; the parent route remounts the component on doc change.
  }, []);

  return (
    <div className="editor-shell">
      <ConnectionStatus provider={provider} />
      <div ref={containerRef} className="editor-surface" />
    </div>
  );
}
