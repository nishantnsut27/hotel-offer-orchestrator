import { isCancellation, log, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { HotelActivities, HotelOffer, HotelWorkflowInput } from '../domain/hotels';
import { selectBestOffers, sortHotelOffers } from '../domain/selection';

const { fetchSupplierHotels } = proxyActivities<Pick<HotelActivities, 'fetchSupplierHotels'>>({
  startToCloseTimeout: '5 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '2 seconds',
  },
});
const { saveAndQueryOffers } = proxyActivities<Pick<HotelActivities, 'saveAndQueryOffers'>>({
  startToCloseTimeout: '3 seconds',
  retry: { maximumAttempts: 2, initialInterval: '1 second', maximumInterval: '1 second' },
});

export async function hotelSearchWorkflow(input: HotelWorkflowInput): Promise<HotelOffer[]> {
  const workflowId = workflowInfo().workflowId;
  const request = { city: input.search.city, requestId: input.requestId, workflowId };
  const fields = { requestId: input.requestId, workflowId };
  log.info('hotels.workflow_started', fields);
  try {
    const [supplierA, supplierB] = await Promise.all([
      fetchSupplierHotels({ ...request, supplier: 'Supplier A' }),
      fetchSupplierHotels({ ...request, supplier: 'Supplier B' }),
    ]);
    const offers = selectBestOffers(supplierA, supplierB);
    const matches = await saveAndQueryOffers({ ...input, workflowId, offers });
    log.info('hotels.workflow_completed', { ...fields, hotels: matches.length });
    return sortHotelOffers(matches);
  } catch (error) {
    log.warn('hotels.workflow_failed', {
      ...fields,
      failureType: isCancellation(error) ? 'CancelledFailure' : 'WorkflowFailure',
    });
    throw error;
  }
}
