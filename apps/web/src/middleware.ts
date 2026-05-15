import { defineMiddleware } from 'astro:middleware';
import { getSession } from './lib/session.ts';

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  if (url.pathname.startsWith('/app')) {
    const session = await getSession(context.cookies);
    if (!session) {
      return context.redirect('/auth/login');
    }
    context.locals.auth = session;
  }
  return next();
});
