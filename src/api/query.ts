import { z } from 'zod';
import type { HotelSearch } from '../domain/hotels';
import { HttpError } from './errors';

const city = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.toLowerCase());
const price = z
  .string()
  .trim()
  .regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i)
  .transform(Number)
  .pipe(z.number().finite().nonnegative());
const searchQuery = z
  .object({ city, minPrice: price.optional(), maxPrice: price.optional() })
  .refine(
    (value) =>
      value.minPrice === undefined ||
      value.maxPrice === undefined ||
      value.minPrice <= value.maxPrice,
  );

export function parseHotelSearch(query: unknown): HotelSearch {
  const result = searchQuery.safeParse(query);
  if (!result.success) throw new HttpError(400, 'INVALID_QUERY', 'Invalid hotel search query');
  return {
    city: result.data.city,
    ...(result.data.minPrice !== undefined ? { minPrice: result.data.minPrice } : {}),
    ...(result.data.maxPrice !== undefined ? { maxPrice: result.data.maxPrice } : {}),
  };
}

export function parseSupplierCity(query: unknown): string | undefined {
  const result = z.object({ city: city.optional() }).safeParse(query);
  if (!result.success) throw new HttpError(400, 'INVALID_QUERY', 'Invalid supplier city query');
  return result.data.city;
}
