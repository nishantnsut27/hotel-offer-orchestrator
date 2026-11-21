import { z } from 'zod';
import { InvalidStoredOffersError } from '../domain/errors';
import type { HotelOffer, StoreOffersInput } from '../domain/hotels';
import type { RedisConnection } from './client';

const replaceAndQuery = `
local key = KEYS[1]
redis.call('DEL', key)
for index = 3, #ARGV, 2 do
  redis.call('ZADD', key, ARGV[index], ARGV[index + 1])
end
if #ARGV > 2 then redis.call('EXPIRE', key, 300) end
return redis.call('ZRANGEBYSCORE', key, ARGV[1], ARGV[2])
`;

const offerSchema = z.array(
  z.strictObject({
    name: z.string().refine((value) => value.trim().length > 0),
    price: z.number().finite().nonnegative(),
    supplier: z.enum(['Supplier A', 'Supplier B']),
    commissionPct: z.number().finite().min(0).max(100),
  }),
);

export function hotelOffersKey(workflowId: string): string {
  return `hotel-offers:results:${workflowId}`;
}

export async function saveAndQueryOffers(
  redis: RedisConnection,
  input: StoreOffersInput,
  signal: AbortSignal,
): Promise<HotelOffer[]> {
  const result: unknown = await redis
    .withCommandOptions({ timeout: 2000, abortSignal: signal })
    .eval(replaceAndQuery, {
      keys: [hotelOffersKey(input.workflowId)],
      arguments: [
        input.search.minPrice?.toString() ?? '-inf',
        input.search.maxPrice?.toString() ?? '+inf',
        ...input.offers.flatMap((offer) => [offer.price.toString(), JSON.stringify(offer)]),
      ],
    });
  const members = z.array(z.string()).safeParse(result);
  if (!members.success) throw new InvalidStoredOffersError('Redis returned invalid offer members');
  try {
    const decoded: unknown[] = members.data.map((member): unknown => JSON.parse(member));
    const offers = offerSchema.safeParse(decoded);
    if (offers.success) return offers.data;
  } catch {
    throw new InvalidStoredOffersError('Redis returned invalid offer JSON');
  }
  throw new InvalidStoredOffersError('Redis returned invalid offers');
}
