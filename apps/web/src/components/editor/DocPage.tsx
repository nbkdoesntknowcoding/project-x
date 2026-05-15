import type { DocFull } from '@boppl/shared';
import { type JSX, useCallback, useState } from 'react';
import { api } from '../../lib/api';
import { Editor } from './Editor';

interface DocPageProps {
  initialDoc: DocFull;
  jwt: string;
  user: { id: string; email: string };
}

export function DocPage({ initialDoc, jwt, user }: DocPageProps): JSX.Element {
  const [title, setTitle] = useState(initialDoc.title);
  const [savedTitle, setSavedTitle] = useState(initialDoc.title);

  const handleTitleBlur = useCallback(async (): Promise<void> => {
    if (title === savedTitle) return;
    // Title still saves through REST. The body is owned by the collab session.
    // We send the original markdown unchanged so the schema validator passes;
    // 1.2 will tighten the API contract to allow title-only updates.
    await api.saveDoc(initialDoc.id, { title, markdown: initialDoc.markdown });
    setSavedTitle(title);
  }, [title, savedTitle, initialDoc.id, initialDoc.markdown]);

  return (
    <div className="doc-page">
      <input
        className="doc-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={handleTitleBlur}
        placeholder="Untitled"
        autoComplete="off"
        spellCheck
      />
      <Editor
        docId={initialDoc.id}
        initialMarkdown={initialDoc.markdown}
        jwt={jwt}
        user={user}
      />
    </div>
  );
}
