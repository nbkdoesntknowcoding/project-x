export interface DocSummary {
  id: string;
  path: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface DocFull extends DocSummary {
  markdown: string;
  content_hash: string | null;
  is_public?: boolean;
  public_token?: string | null;
}

export interface DocCreatePayload {
  title?: string;
  markdown?: string;
}

export interface DocSavePayload {
  title: string;
  markdown?: string;
}

export interface DocSaveResponse {
  id: string;
  title: string;
  content_hash: string | null;
  updated_at: string;
}
