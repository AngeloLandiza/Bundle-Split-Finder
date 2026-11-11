/** Where the owner can check a part against Amazon. Neither link spends a search. */
export const amazonListingUrl = (asin: string): string => `https://www.amazon.com/dp/${asin}`;

export const amazonSearchUrl = (brand: string, model: string): string =>
  `https://www.amazon.com/s?k=${encodeURIComponent(`${brand} ${model}`)}`;
