# Bulala dynamic coin settings

The supplier's slug is `coin-recharge`, adapter is `dealer-api`, and external product ID is `ibulala_dynamic_coins`. The settings workflow never calls `/dealer/sale`.

## Administration

Edit Bulala in Suppliers, then choose **إعداد شحن العملات**. Enter the product name, USD cost per coin as a decimal string, and positive integer quantity bounds. There are no prefilled commercial prices or limits. Saving prepares one automatic store product, including its player ID input and provider mapping. Reopening reads MongoDB.

- `GET /api/providers/:id/coin-settings` returns `{ settings: null }` before configuration, or the saved settings.
- `PUT /api/providers/:id/coin-settings` accepts `{ name, unitCost, minQty, maxQty }`. `unitCost` must be a positive decimal **string**, with at most 50 decimal places; quantities must be safe integers with `1 <= minQty <= maxQty`.
- Both require an authenticated ADMIN or SUPERVISOR with `MANAGE_SUPPLIERS`; saving also requires `MANAGE_PRODUCTS`. Existing ADMIN permission bypass applies.

The settings live in `ProviderProduct.adminSettings`. A MongoDB transaction updates the raw catalogue and linked store product together. Existing markup or manual adjustment is applied to the entered cost; new products start with zero product markup, and normal customer/group pricing still applies. Existing order snapshots are never rewritten. The provider catalogue's placeholder is unavailable until configured. Generic product publishing cannot create extra Bulala products.

The natural unique key on ProviderProduct and a partial unique `Product.bulalaDynamicKey` index prevent concurrent saves from creating duplicate products. Multiple legacy linked products cause a conflict requiring manual inspection; nothing is deleted automatically. Sync cannot overwrite administrator settings, and managed Bulala checkout bypasses remote price-cache repricing.

## Fulfillment and uncertainty

Checkout and the adapter enforce configured quantity bounds. The mapped player ID is sent as `toUserId`, and the selected quantity as `coins`. A persisted compare-and-set claim allows at most one sale attempt per order. Only provider success code `200` completes a sale. Existing documented rejection codes `131` and `138` follow the existing failure/refund path.

Timeouts, network errors, unexpected responses and unknown error codes after dispatch remain `PLACEMENT_UNCERTAIN`. No automatic resubmission or refund occurs. Dealer API has no verified reference lookup in this implementation: the existing fulfillment poller eventually moves unresolved placements to `MANUAL_REVIEW`. Verify such orders against the provider account/transaction history before resolving them. `checkOrder` and `checkOrders` never invent a successful result.

## Safe production update

1. Back up the production database and record Git status/HEAD for both server repositories. Preserve local/uncommitted production changes on a separate branch or commit; do not reset or overwrite the checkout. Preserve all existing secrets, payment settings and authentication session directories.
2. The local source used for this feature does **not** contain objects `00f9678`, `39b5f33`, or `81a51f7`. On a staging copy based on the actual server history, cherry-pick the backend and frontend feature commits. Resolve conflicts against those production fixes; never replace the server tree with this local baseline. Review the resulting diff to ensure WhatsApp, Vodafone Cash, payment data and sessions remain intact.
3. MongoDB must support multi-document transactions (replica set or sharded cluster). Check existing Bulala ProviderProduct/Product links before deployment. Build the new partial unique index using `Product.createIndexes()` with the project's configured database connection; do not use `syncIndexes()` on production. Retain the existing unique provider/external-product index.
4. Install locked dependencies, run backend tests with an isolated MongoDB replica set, and run frontend lint/build. All new supplier sale tests mock Axios. Do not test with a real sale.
5. Deploy backend and frontend together under your existing deployment procedure, with a rollback checkpoint. Confirm Bulala's supplier identity and `dealer-api` adapter, then enter your own commercial values through the new window. Confirm reload, product linkage, price and quantity bounds before accepting customer orders. Do not change old order prices or resubmit uncertain orders.

No production deployment or live recharge is part of the implementation task. Feature branches can be reviewed and integrated without changing production automatically.

## Verification on 2026-11-25

- Focused settings/provider/adapter/fulfillment tests: **85 passed**, with an isolated MongoDB 8.2.1 replica set and mocked supplier HTTP calls.
- Full backend run: **969 passed, 54 failed** across 46 suites. A separate pristine snapshot of baseline `655b222` returned **941 passed, 54 failed** across 45 suites; all 54 failing test names matched, with no new failing names. The last two added success/rejection integration cases and the manual-verification status guard were subsequently covered by the passing focused run.
- Frontend `npm run lint` and `npm run build`: exit code **0**.
- Full-suite failures remain outside the Bulala change, including pre-existing authentication/profile/session expectations. Do not treat the entire backend suite as green.
