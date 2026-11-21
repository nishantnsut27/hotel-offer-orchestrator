export type SupplierName = 'Supplier A' | 'Supplier B';

export interface SupplierHotel {
  hotelId: string;
  name: string;
  price: number;
  city: string;
  commissionPct: number;
}

export interface HotelOffer {
  name: string;
  price: number;
  supplier: SupplierName;
  commissionPct: number;
}

export interface HotelSearch {
  city: string;
  minPrice?: number;
  maxPrice?: number;
}

export interface HotelWorkflowInput {
  search: HotelSearch;
  requestId: string;
}

export interface SupplierActivityInput {
  city: string;
  supplier: SupplierName;
  requestId: string;
  workflowId: string;
}

export interface StoreOffersInput extends HotelWorkflowInput {
  offers: HotelOffer[];
  workflowId: string;
}

export interface HotelActivities {
  fetchSupplierHotels(input: SupplierActivityInput): Promise<SupplierHotel[]>;
  saveAndQueryOffers(input: StoreOffersInput): Promise<HotelOffer[]>;
}
