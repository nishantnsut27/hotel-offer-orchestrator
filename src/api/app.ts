import { randomUUID } from 'node:crypto';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { Logger } from '../logger';
import { infrastructureReady } from '../domain/infrastructure';
import type { InfrastructureChecks, ProbeResult, SupplierChecks } from '../domain/infrastructure';
import type { HotelOffer, HotelWorkflowInput } from '../domain/hotels';
import { getSupplierHotels } from '../suppliers/fixtures';
import { HttpError, mapHotelSearchError, mapProbeError } from './errors';
import { parseHotelSearch, parseSupplierCity } from './query';

interface AppDependencies {
  log: Logger;
  getInfrastructure?: () => Promise<InfrastructureChecks>;
  getSupplierHealth?: () => Promise<SupplierChecks>;
  supplierADown?: boolean;
  supplierBDown?: boolean;
  executeProbe?: (workflowId: string) => Promise<ProbeResult>;
  executeHotelSearch?: (workflowId: string, input: HotelWorkflowInput) => Promise<HotelOffer[]>;
  enableInfraProbe?: boolean;
}

export function createApp({
  log,
  getInfrastructure = () =>
    Promise.resolve({
      api: 'up',
      worker: 'not_configured',
      temporal: 'not_configured',
      redis: 'not_configured',
    }),
  executeProbe,
  getSupplierHealth = () =>
    Promise.resolve({ supplierA: 'not_configured', supplierB: 'not_configured' }),
  supplierADown = false,
  supplierBDown = false,
  executeHotelSearch,
  enableInfraProbe = false,
}: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'extended');

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
      endpoints: {
        liveness: '/health/live',
        readiness: '/health/ready',
        health: '/health',
        hotels: '/api/hotels',
        supplierA: '/supplierA/hotels',
        supplierB: '/supplierB/hotels',
        ...(enableInfraProbe ? { probe: '/internal/probe' } : {}),
      },
    });
  });

  app.get('/health/live', (_request, response) => {
    response.json({ status: 'up' });
  });

  app.get('/supplierA/hotels', (request, response) => {
    if (supplierADown) throw new HttpError(503, 'SUPPLIER_UNAVAILABLE', 'Supplier is unavailable');
    response.json(getSupplierHotels('Supplier A', parseSupplierCity(request.query)));
  });
  app.get('/supplierB/hotels', (request, response) => {
    if (supplierBDown) throw new HttpError(503, 'SUPPLIER_UNAVAILABLE', 'Supplier is unavailable');
    response.json(getSupplierHotels('Supplier B', parseSupplierCity(request.query)));
  });
  app.get('/api/hotels', async (request, response) => {
    const search = parseHotelSearch(request.query);
    const requestId = response.getHeader('x-request-id');
    if (typeof requestId !== 'string') throw new Error('Missing request identifier');
    const workflowId = `hotels-${requestId}`;
    if (!executeHotelSearch) {
      throw new HttpError(503, 'HOTEL_SEARCH_UNAVAILABLE', 'Hotel search is unavailable');
    }
    log('info', 'hotels.started', { requestId, workflowId });
    try {
      const offers = await executeHotelSearch(workflowId, { search, requestId });
      log('info', 'hotels.completed', { requestId, workflowId, hotels: offers.length });
      response.json(offers);
    } catch (error) {
      log('warn', 'hotels.failed', { requestId, workflowId });
      throw mapHotelSearchError(error);
    }
  });

  app.get('/health/ready', async (_request, response) => {
    const checks = await getInfrastructure();
    const ready = infrastructureReady(checks);
    response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
  });

  app.get('/health', async (_request, response) => {
    const [infrastructure, suppliers] = await Promise.all([
      getInfrastructure(),
      getSupplierHealth(),
    ]);
    const checks = { ...infrastructure, ...suppliers };
    const ready = Object.values(checks).every((status) => status === 'up');
    response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
  });

  if (enableInfraProbe) {
    app.get('/internal/probe', async (_request, response) => {
      const workflowId = `infra-${randomUUID()}`;
      if (!executeProbe) {
        throw new HttpError(503, 'INFRASTRUCTURE_UNAVAILABLE', 'Infrastructure is unavailable');
      }
      try {
        const result = await executeProbe(workflowId);
        log('info', 'probe.completed', {
          workflowId,
          requestId: response.getHeader('x-request-id'),
        });
        response.json(result);
      } catch (error) {
        log('warn', 'probe.failed', { workflowId, requestId: response.getHeader('x-request-id') });
        throw mapProbeError(error);
      }
    });
  }

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

    const failure =
      error instanceof HttpError
        ? error
        : new HttpError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    response.status(failure.status).json({
      error: { code: failure.code, message: failure.message },
    });
  };

  app.use(handleError);
  return app;
}
