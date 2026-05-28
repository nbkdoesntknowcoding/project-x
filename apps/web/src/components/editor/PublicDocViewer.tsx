import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import { type JSX, useEffect, useRef } from 'react';
import './editor.css';

interface PublicDocViewerProps {
  markdown: string;
}

/**
 * Read-only Milkdown/Crepe viewer for the public share page.
 * No collab, no auth, no toolbar — just renders the markdown.
 */
export function PublicDocViewer({ markdown }: PublicDocViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const crepeRef = useRef<Crepe | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const crepe = new Crepe({
      root: containerRef.current,
      defaultValue: markdown,
    });
    crepeRef.current = crepe;

    void crepe.create().then(() => {
      crepe.setReadonly(true);
    });

    return () => {
      void crepe.destroy();
      crepeRef.current = null;
    };
    // markdown prop is SSR-provided and never changes in this page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="milkdown-public-viewer" />;
}
