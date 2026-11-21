import type { HotelOffer, SupplierHotel, SupplierName } from './hotels';

export function sortHotelOffers(offers: readonly HotelOffer[]): HotelOffer[] {
  return [...offers].sort((left, right) => {
    if (left.price !== right.price) return left.price - right.price;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
}

export function selectBestOffers(
  supplierA: readonly SupplierHotel[],
  supplierB: readonly SupplierHotel[],
): HotelOffer[] {
  const selected = new Map<string, HotelOffer>();
  const sources: Array<{ supplier: SupplierName; hotels: readonly SupplierHotel[] }> = [
    { supplier: 'Supplier A', hotels: supplierA },
    { supplier: 'Supplier B', hotels: supplierB },
  ];

  for (const { supplier, hotels } of sources) {
    for (const hotel of hotels) {
      const key = hotel.name.trim().toLowerCase();
      const previous = selected.get(key);
      if (
        !previous ||
        hotel.price < previous.price ||
        (hotel.price === previous.price &&
          supplier === 'Supplier A' &&
          previous.supplier !== supplier)
      ) {
        selected.set(key, {
          name: hotel.name,
          price: hotel.price,
          supplier,
          commissionPct: hotel.commissionPct,
        });
      }
    }
  }
  return sortHotelOffers([...selected.values()]);
}
