import type { SupplierHotel, SupplierName } from '../domain/hotels';

const fixtures: Record<SupplierName, readonly SupplierHotel[]> = {
  'Supplier A': [
    { hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10 },
    { hotelId: 'a2', name: 'Radison', price: 5900, city: 'delhi', commissionPct: 13 },
    { hotelId: 'a3', name: 'Oberoi', price: 7000, city: 'delhi', commissionPct: 15 },
    { hotelId: 'a4', name: 'MetroStay', price: 4500, city: 'delhi', commissionPct: 12 },
    { hotelId: 'a5', name: 'Sea View', price: 5200, city: 'mumbai', commissionPct: 10 },
    { hotelId: 'a6', name: 'Harbour Grand', price: 7800, city: 'mumbai', commissionPct: 12 },
  ],
  'Supplier B': [
    { hotelId: 'b1', name: 'Holtin', price: 5340, city: 'delhi', commissionPct: 20 },
    { hotelId: 'b2', name: 'Radison', price: 6200, city: 'delhi', commissionPct: 15 },
    { hotelId: 'b3', name: 'Oberoi', price: 7000, city: 'delhi', commissionPct: 18 },
    { hotelId: 'b4', name: 'CityInn', price: 4800, city: 'delhi', commissionPct: 14 },
    { hotelId: 'b5', name: 'Sea View', price: 5000, city: 'mumbai', commissionPct: 18 },
    { hotelId: 'b6', name: 'West End', price: 6400, city: 'mumbai', commissionPct: 14 },
  ],
};

export function getSupplierHotels(supplier: SupplierName, city?: string): readonly SupplierHotel[] {
  return city === undefined
    ? fixtures[supplier]
    : fixtures[supplier].filter((hotel) => hotel.city === city);
}
