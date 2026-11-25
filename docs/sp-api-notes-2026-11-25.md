# Amazon Selling Partner API: what was established on Nov 25 2026

For a single seller connecting his OWN account from the desktop app (a "private application", self-authorized). Read
from Amazon's own pages by a research pass; each point has its URL. Doc pages redirect from developer-docs.amazon.com to
developer-docs.amazon. Nothing here was verified by a live call: the first real responses must be captured as samples
and these notes corrected from them (CLAUDE.md: a recorded response beats the docs).

## Getting access (the seller does this once, in Seller Central)
- Needs a professional account and the Primary User. Seller Central > Apps and Services > Develop Apps > register as a
  private developer (contact, data access = private, roles, use cases, security controls; accept the agreements).
  A case Amazon opens must be answered within 5 days. No approval time is documented.
  https://developer-docs.amazon/sp-api/docs/registering-as-a-developer
  https://developer-docs.amazon/sp-api/docs/register-as-a-private-developer.md
- Roles needed, none of them "restricted" (no PII): Product Listing (Listings Restrictions, Product Fees, Sales),
  Amazon Fulfillment (FBA Inbound Eligibility), Inventory and Order Tracking (Sales), Finance and Accounting (optional).
  https://developer-docs.amazon/sp-api/docs/role-mappings.md
- Self-authorization: in Develop Apps, Authorize application > Authorize app gives a refresh token ("long-lived", no
  expiry stated; each click makes a new one, earlier ones stay valid).
  https://developer-docs.amazon/sp-api/docs/self-authorization
- AWS IAM / SigV4 signing is not required since 2 Oct 2023.
  https://developer-docs.amazon.com/sp-api/changelog/sp-api-will-no-longer-require-aws-iam-or-aws-signature-version-4
- The seller's `sellerId` ("merchant token"): where to find it was NOT confirmed from the docs (probably Seller Central,
  Account Info).
- Fees for API access: Amazon announced developer fees for 2026 for third-party developers and then posted that it
  "will not move forward" with them; a private single-seller app was not the target.
  https://developer.amazonservices.com/cancellation-of-sp-api-fees

## Run time
- Token: `POST https://api.amazon.com/auth/o2/token`, form-encoded, `grant_type=refresh_token`, `refresh_token`,
  `client_id`, `client_secret` (no `scope`). Access token lasts 3600 s.
- Each request: headers `x-amz-access-token`, `x-amz-date`, `host`, and a required `user-agent`
  ("AppName/Version (Language=...)"). North America: `https://sellingpartnerapi-na.amazon.com`. US marketplace id
  `ATVPDKIKX0DER`.
  https://developer-docs.amazon/sp-api/docs/connecting-to-the-selling-partner-api
  https://developer-docs.amazon/sp-api/docs/sp-api-endpoints.md

## May he list it? Listings Restrictions
- `GET /listings/2021-08-01/restrictions` with `asin`, `sellerId`, `marketplaceIds` (required), `conditionType`
  (`new_new` for this app), `reasonLocale` (`en_US`).
- Response: `restrictions[]` each `{ marketplaceId, conditionType, reasons[] }`; a reason is
  `{ message, reasonCode, links[] { resource, verb, title, type } }`. `reasonCode`: `APPROVAL_REQUIRED` (a path-forward
  link may be given), `ASIN_NOT_FOUND`, `NOT_ELIGIBLE` (no link). An empty `restrictions` means no restriction.
- 5 requests a second, burst 10.
  https://raw.githubusercontent.com/amzn/selling-partner-api-models/main/models/listings-restrictions-api-model/listingsRestrictions_2021-08-01.json
  https://developer-docs.amazon/sp-api/docs/listings-restrictions-api-rate-limits

## Will FBA take it? FBA Inbound Eligibility
- `GET /fba/inbound/v1/eligibility/itemPreview` with `asin`, `program=INBOUND`, `marketplaceIds` (one).
- Response `payload { asin, program, isEligibleForProgram, ineligibilityReasonList[] }`. 1 request a second, burst 1.
- Reason codes (paraphrased from the model): FBA_INB_0004 missing dimensions; 0007 to 0013 hazmat review needs more
  information (0008 battery details, 0009 a Safety Data Sheet); 0014 possible dangerous goods, review takes 4 to 7
  business days; 0015 unfulfillable dangerous goods, inventory must be disposed of; 0016 fulfillable dangerous goods,
  may need FBA Hazmat programme enrolment; 0051 blocked by FBA; 0053 shipping option or size/weight not eligible;
  0097 fully regulated dangerous good; 0098 seller not authorised for the marketplace; 0099 account terminated;
  0104 and 0342 barcode issues; 0197 safety and compliance documents required; 0465 not the brand representative;
  UNKNOWN_INB_ERROR_CODE.
  https://raw.githubusercontent.com/amzn/selling-partner-api-models/main/models/fba-inbound-eligibility-api-model/fbaInbound.json

## What will Amazon charge him? Product Fees
- One: `POST /products/fees/v0/items/{Asin}/feesEstimate`, body `FeesEstimateRequest { MarketplaceId,
  PriceToEstimateFees { ListingPrice, Shipping, Points } (each { CurrencyCode, Amount }), Identifier,
  IsAmazonFulfilled, OptionalFulfillmentProgram? }`. 1 a second, burst 2.
- Batch: `POST /products/fees/v0/feesEstimate`, an array of `{ IdType: ASIN|SellerSKU, IdValue, FeesEstimateRequest }`,
  up to 20 items, 0.5 a second, burst 1.
- Response: `TotalFeesEstimate` and `FeeDetailList[] { FeeType, FeeAmount, FinalFee, FeePromotion, TaxAmount,
  IncludedFeeDetailList }`. The model does not list the FeeType values: take them from the first real response.
  https://raw.githubusercontent.com/amzn/selling-partner-api-models/main/models/product-fees-api-model/productFeesV0.json

## What did he sell? Sales (least privilege, no PII)
- `GET /sales/v1/orderMetrics` with one `marketplaceIds`, `interval`, `granularity` (Day), `granularityTimeZone`,
  optional `asin`. Returns per interval `unitCount`, `orderItemCount`, `orderCount`, `averageUnitPrice`, `totalSales`.
  0.5 a second, burst 15. Roles: Inventory and Order Tracking or Product Listing.
  https://raw.githubusercontent.com/amzn/selling-partner-api-models/main/models/sales-api-model/sales.json
- Orders v0 is deprecated (removed 27 Mar 2027); not needed for this.

## Rules
- Do not hardcode credentials; keep the refresh token in an encrypted or owner-only store, never in logs or URLs.
- Avoiding the PII roles avoids the 30-day deletion and encryption-of-PII duties. Non-PII retention limit: 18 months.
- No text was found that forbids modest automated use; the rate limiter enforces the published rates.

## Not confirmed
Where `sellerId` is shown; refresh-token expiry; the full text of the Data Protection and Acceptable Use policies;
the FeeType values; whether hazmat detail beyond the reason codes is readable.

## Correcting these notes
The app keeps the first three answers of each operation (scrubbed of every credential and seller id) in
`runtime.spapiSamples`, which is in the audit export (Settings, Data). Correct the points above from those, then the
parsers in `core/src/amazon/spapi/parse.ts`. See docs/decisions.md, "Nov 25: the owner's Amazon seller account".
