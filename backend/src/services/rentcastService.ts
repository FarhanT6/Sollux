import axios from 'axios';

const RENTCAST_BASE = 'https://api.rentcast.io/v1';

function client() {
  const apiKey = process.env.RENTCAST_API_KEY;
  if (!apiKey) throw new Error('RENTCAST_API_KEY is not configured');
  return axios.create({
    baseURL: RENTCAST_BASE,
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
  });
}

export interface RentcastPropertyRecord {
  addressLine1?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  county?: string;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  lotSize?: number;
  yearBuilt?: number;
  lastSaleDate?: string;
  lastSalePrice?: number;
  ownerOccupied?: boolean;
}

export interface RentcastValueEstimate {
  price?: number;
  priceRangeLow?: number;
  priceRangeHigh?: number;
  latitude?: number;
  longitude?: number;
  comparables?: unknown[];
}

interface AddressQuery {
  address: string;
  city: string;
  state: string;
  zip?: string;
}

function fullAddress(q: AddressQuery): string {
  return `${q.address}, ${q.city}, ${q.state}${q.zip ? ` ${q.zip}` : ''}`;
}

/** Property records lookup: beds/baths/sqft/lot size/year built/last sale. */
export async function lookupPropertyRecord(q: AddressQuery): Promise<RentcastPropertyRecord | null> {
  const res = await client().get('/properties', { params: { address: fullAddress(q) } });
  const record = Array.isArray(res.data) ? res.data[0] : res.data;
  return record ?? null;
}

/** Automated valuation (AVM). */
export async function lookupValueEstimate(q: AddressQuery): Promise<RentcastValueEstimate | null> {
  const res = await client().get('/avm/value', { params: { address: fullAddress(q) } });
  return res.data ?? null;
}
