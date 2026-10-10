# Invoicing and PayPal

Koda bills clients from the portal: one-off invoices for development work, and recurring plans for hosting that
can be charged any amount, or nothing. Clients get the invoice by email with a PDF, see and pay their invoices in
the portal through PayPal, once or automatically, and are reminded before and after the due date.

## Data

- `Invoice`, with its `InvoiceLine`s and `InvoicePayment`s. Status is stored as `DRAFT`, `OPEN`, `PAID` or `VOID`;
  due and overdue are worked out from `dueOn` (a Brisbane calendar day) when shown, so nothing has to mark an
  invoice late. Amounts are whole cents; a line's float quantity is rounded to the cent once, in `money.ts`.
- The number comes from a one-row `InvoiceCounter`, taken in the same statement that advances it, when the invoice
  is sent. Drafts have no number, so a deleted draft leaves no gap.
- Who an invoice is addressed to is copied onto it and frozen when it is sent. Deleting a client keeps their
  invoices (SetNull), and cancels their PayPal subscriptions first.
- `BillingPlan`: a price, monthly or yearly, a start day and days to pay. Period n is counted from `startsOn`
  (`plans.ts`), so a plan that starts on the 31st stays on month ends. `periodsBilled` is claimed with a
  compare-and-set in the same transaction that creates the invoice, so two runs can never bill a period twice.
- GST is per invoice, from `GST_REGISTERED` at the time it is written. Off by default: the business is not
  registered, so invoices say "Invoice" (never "Tax invoice") and "No GST has been charged". The ABN is always shown.

## PayPal

`server/paypal` talks to the REST API over fetch. `PAYPAL_MODE` is `sandbox` (default) or `live`; live is refused
outside a production build. Plan and subscription ids are stored with the mode they belong to, and only count in
that mode.

- **Paying once**: Orders v2, with the invoice id as `custom_id` and the invoice number as `invoice_id` (PayPal then
  refuses to capture the same number twice). The client approves at PayPal and returns to `/api/paypal/return`,
  which captures. The return route sits outside `/portal`, so it needs no session.
- **Paying automatically**: a Catalog product and Billing plan per `BillingPlan`, made the first time a client asks,
  and a Subscription with the plan id as `custom_id`. The first payment is taken on approval, which settles the
  plan's open invoice; later ones each raise the period's invoice already paid. A changed price is pushed to the
  PayPal plan. While a subscription is active the hourly run leaves the plan to PayPal; suspended, cancelled or
  expired puts it back on invoices.
- **Webhooks** (`/api/paypal/webhook`) are verified with PayPal's verify-webhook-signature call, then handled by
  `webhook.ts`. Every handler is idempotent: a payment is keyed by PayPal's capture or sale id (unique), so the
  return page and the webhook reporting the same payment record it once.

## The hourly run

Started from `instrumentation.ts` in the site's own process. It raises due plan invoices (up to three missed
periods at a time), then, between 9am and 6pm Brisbane, sends a reminder three days before the due date and
overdue notices 1, 7 and 14 days after it, at least five days apart. Each email is claimed on its row before it
is sent.

## Activity

Everything goes in the activity log under a new Billing category, with a new `SYSTEM` actor for what the run and
PayPal do on their own. Every email is in the sent-mail log as usual; the PDF attachment is not stored, since it
can be drawn again.
