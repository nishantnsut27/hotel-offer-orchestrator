import { ApplicationFailure, CancelledFailure, Context } from '@temporalio/activity';
import type { AppConfig } from '../config/env';
import { InvalidStoredOffersError, SupplierError } from '../domain/errors';
import type { HotelActivities } from '../domain/hotels';
import type { Logger } from '../logger';
import type { RedisConnection } from '../redis/client';
import { saveAndQueryOffers } from '../redis/offers';
import { fetchSupplierHotels } from '../suppliers/client';

export function createHotelActivities(
  config: AppConfig,
  redis: RedisConnection,
  log: Logger,
): HotelActivities {
  return {
    async fetchSupplierHotels(input) {
      const context = Context.current();
      const fields = {
        workflowId: input.workflowId,
        requestId: input.requestId,
        supplier: input.supplier,
        attempt: context.info.attempt,
      };
      log('info', 'supplier.activity_started', fields);
      try {
        const endpoint =
          input.supplier === 'Supplier A' ? config.supplierAUrl : config.supplierBUrl;
        const hotels = await fetchSupplierHotels(endpoint, input.city, context.cancellationSignal);
        log('info', 'supplier.activity_completed', { ...fields, hotels: hotels.length });
        return hotels;
      } catch (error) {
        log('warn', 'supplier.activity_failed', {
          ...fields,
          failureType: context.cancellationSignal.aborted
            ? 'CancelledFailure'
            : error instanceof SupplierError
              ? error.type
              : 'UnexpectedFailure',
        });
        if (context.cancellationSignal.aborted)
          throw new CancelledFailure('Supplier activity cancelled');
        if (error instanceof SupplierError) {
          throw ApplicationFailure.create({
            message: error.message,
            type: error.type,
            nonRetryable: !error.retryable,
          });
        }
        throw error;
      }
    },
    async saveAndQueryOffers(input) {
      const context = Context.current();
      const fields = {
        workflowId: input.workflowId,
        requestId: input.requestId,
        attempt: context.info.attempt,
      };
      log('info', 'offers.activity_started', fields);
      try {
        const offers = await saveAndQueryOffers(redis, input, context.cancellationSignal);
        log('info', 'offers.activity_completed', {
          ...fields,
          stored: input.offers.length,
          matched: offers.length,
        });
        return offers;
      } catch (error) {
        log('warn', 'offers.activity_failed', {
          ...fields,
          failureType: context.cancellationSignal.aborted
            ? 'CancelledFailure'
            : error instanceof InvalidStoredOffersError
              ? 'RedisDataInvalid'
              : 'RedisUnavailable',
        });
        if (context.cancellationSignal.aborted)
          throw new CancelledFailure('Redis activity cancelled');
        if (error instanceof InvalidStoredOffersError) {
          throw ApplicationFailure.nonRetryable(
            'Redis returned invalid offers',
            'RedisDataInvalid',
          );
        }
        throw ApplicationFailure.retryable('Redis is unavailable', 'RedisUnavailable');
      }
    },
  };
}
