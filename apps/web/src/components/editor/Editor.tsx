import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { editorViewCtx } from '@milkdown/core';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { EditorView } from 'prosemirror-view';
import { type JSX, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import './editor.css';
import { $prose } from '@milkdown/kit/utils';
import { ConnectionStatus } from './ConnectionStatus';
import { createAutocompletePlugin } from './plugins/autocomplete/plugin';
import { mathPlugin } from './plugins/math';
import { configureMermaidPreview } from './plugins/mermaid';
import { createCommentAnchorPlugin } from '../comments/CommentAnchorPlugin';

export interface EditorSelection {
  from: number;
  to: number;
}

interface EditorProps {
  docId: string;
  initialMarkdown: string;
  jwt: string;
  user: { id: string; email: string };
  collabUrl?: string;
  /** Called once the EditorView is mounted (and again with null on
   *  teardown). The parent uses this to drive the comments overlay. */
  onViewReady?: (view: EditorView | null) => void;
  /** Called on every selection change. The parent uses this to know
   *  what range a ⌘⇧M shortcut should anchor to. */
  onSelectionChange?: (sel: EditorSelection | null) => void;
  /** Exposes the HocuspocusProvider to the parent for status tracking. */
  onProviderReady?: (provider: HocuspocusProvider | null) => void;
}

const USER_COLOR_PALETTE: readonly string[] = [
  '#60a5fa',
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
  return USER_COLOR_PALETTE[hash % USER_COLOR_PALETTE.length] ?? '#60a5fa';
}

export function Editor({
  docId,
  initialMarkdown,
  jwt,
  user,
  collabUrl,
  onViewReady,
  onSelectionChange,
  onProviderReady,
}: EditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  // Stash callbacks in refs so the mount-once effect doesn't need them
  // in its deps (changing onSelectionChange would otherwise tear down the
  // whole editor on every parent rerender).
  const onViewReadyRef = useRef(onViewReady);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onProviderReadyRef = useRef(onProviderReady);
  useEffect(() => {
    onViewReadyRef.current = onViewReady;
    onSelectionChangeRef.current = onSelectionChange;
    onProviderReadyRef.current = onProviderReady;
  }, [onViewReady, onSelectionChange, onProviderReady]);

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
    onProviderReadyRef.current?.(hp);

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

    // Phase 3.3 autocomplete: stub backend; debounce + AbortController
    // owned per editor mount. The hard-coded values mirror env defaults
    // — 3.4 will read these from PUBLIC_AUTOCOMPLETE_* for runtime tuning.
    const autocompletePlugin = $prose(() =>
      createAutocompletePlugin({
        docId,
        debounceMs: 350,
        maxPrefixChars: 2000,
        maxSuffixChars: 500,
      }),
    );
    crepe.editor.use(autocompletePlugin);

    // Phase 4.2 — comment anchor decoration plugin. Source of truth lives
    // in React; this plugin just renders the highlighted ranges React
    // pushes in via setMeta.
    const commentAnchorProsePlugin = $prose(() => createCommentAnchorPlugin());
    crepe.editor.use(commentAnchorProsePlugin);

    let disposed = false;
    let viewRef: EditorView | null = null;
    let selectionPollTimer: ReturnType<typeof setInterval> | null = null;
    let lastSelectionKey = '';

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

          // Capture the EditorView for the parent. We don't try to wire
          // a prosemirror Plugin.view dispatch listener here (Milkdown owns
          // plugin registration), and instead poll selection on a short
          // interval — cheap, and avoids reaching into Milkdown internals.
          try {
            viewRef = ctx.get(editorViewCtx);
          } catch {
            viewRef = null;
          }
          if (viewRef) {
            onViewReadyRef.current?.(viewRef);
            selectionPollTimer = setInterval(() => {
              const v = viewRef;
              if (!v) return;
              const sel = v.state.selection;
              const key = sel.empty ? 'empty' : `${sel.from}:${sel.to}`;
              if (key === lastSelectionKey) return;
              lastSelectionKey = key;
              onSelectionChangeRef.current?.(
                sel.empty ? null : { from: sel.from, to: sel.to },
              );
            }, 120);
          }
        });
      })
      .catch((err: unknown) => {
        console.error('Crepe init failed', err);
      });

    return () => {
      disposed = true;
      if (selectionPollTimer !== null) {
        clearInterval(selectionPollTimer);
        selectionPollTimer = null;
      }
      onViewReadyRef.current?.(null);
      onProviderReadyRef.current?.(null);
      viewRef = null;
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
