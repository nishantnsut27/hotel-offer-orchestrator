import { z } from 'zod';
import { SupplierError } from '../domain/errors';
import type { SupplierHotel } from '../domain/hotels';

const text = z.string().refine((value) => value.trim().length > 0);
const supplierHotels = z.array(
  z.object({
    hotelId: text,
    name: text,
    price: z.number().finite().nonnegative(),
    city: text,
    commissionPct: z.number().finite().min(0).max(100),
  }),
);

export async function fetchSupplierHotels(
  endpoint: string,
  city: string | undefined,
  cancellation: AbortSignal,
): Promise<SupplierHotel[]> {
  const url = new URL(endpoint);
  if (city !== undefined) url.searchParams.set('city', city);
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(2000)]);
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch {
    throw new SupplierError('Supplier is unavailable', 'SupplierUnavailable', true);
  }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new SupplierError(
      'Supplier rejected the request',
      retryable ? 'SupplierUnavailable' : 'SupplierRequestRejected',
      retryable,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SupplierError('Supplier returned invalid JSON', 'SupplierInvalidPayload', false);
    }
    throw new SupplierError('Supplier response is unavailable', 'SupplierUnavailable', true);
  }
  const result = supplierHotels.safeParse(body);
  if (
    !result.success ||
    (city !== undefined && result.data.some((hotel) => hotel.city.trim().toLowerCase() !== city))
  ) {
    throw new SupplierError(
      'Supplier returned invalid hotel data',
      'SupplierInvalidPayload',
      false,
    );
  }
  return result.data;
}
