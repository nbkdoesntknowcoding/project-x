export interface JwtClaims {
  sub: string;
  tenant_id: string;
  scopes: string[];
  email: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface SessionData {
  user_id: string;
  email: string;
  tenant_id: string;
  workos_user_id: string;
  access_token: string;
  jwt: string;
}
