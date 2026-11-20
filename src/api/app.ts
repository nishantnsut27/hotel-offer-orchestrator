import { randomUUID } from 'node:crypto';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { Logger } from '../logger';

interface AppDependencies {
  log: Logger;
}

export function createApp({ log }: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');

  app.use((request, response, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    response.setHeader('x-request-id', requestId);

    response.once('finish', () => {
      log('info', 'http.request', {
        requestId,
        method: request.method,
        path: request.path,
        status: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });

    next();
  });

  app.get('/', (_request, response) => {
    response.json({
      name: 'Hotel Offer Orchestrator',
      endpoints: { liveness: '/health/live', readiness: '/health' },
    });
  });

  app.get('/health/live', (_request, response) => {
    response.json({ status: 'up' });
  });

  app.get('/health', (_request, response) => {
    response.status(503).json({
      status: 'not_ready',
      checks: {
        api: 'up',
        worker: 'not_configured',
        temporal: 'not_configured',
        redis: 'not_configured',
        supplierA: 'not_configured',
        supplierB: 'not_configured',
      },
    });
  });

  app.use((_request, response) => {
    response.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Endpoint not found' },
    });
  });

  const handleError: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    log('error', 'http.error', {
      requestId: response.getHeader('x-request-id'),
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });

    response.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  };

  app.use(handleError);
  return app;
}
