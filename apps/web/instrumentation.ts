// Q65: server errors to Sentry, off until SENTRY_DSN is set. Next calls register once per server
// instance and onRequestError for every server-side error (route handlers, server components,
// server actions). Browser errors are not sent yet: the inbox only runs on the operator's machine.
import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.SENTRY_DSN) {
    const Sentry = await import("@sentry/node");
    Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV, tracesSampleRate: 0 });
  }
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.SENTRY_DSN) return;
  const Sentry = await import("@sentry/node");
  Sentry.captureException(err, { extra: { path: request.path, method: request.method, route: context.routePath, kind: context.routerKind } });
  await Sentry.flush(2000);
};
