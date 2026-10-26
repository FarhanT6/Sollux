# Stripe: one-time checks before taking outside customers

The automated tests (`npm run test:integration` in `backend/`) prove that signed Stripe events move an account
between plans, that a lapsed account is read-only and that plan limits hold. They do not talk to Stripe. These
checks do: run them once in **test mode** (Stripe dashboard toggle "Test mode"), then once more with a real card
on the live keys, refunding yourself afterwards.

## 1. Settings on Render (API and workers)

| Variable | Where it comes from |
|---|---|
| `STRIPE_SECRET_KEY` | Developers → API keys → Secret key |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_PORTFOLIO` | Product catalog → each plan's monthly price → price id (`price_…`): $19, $49, $99 |
| `STRIPE_WEBHOOK_SECRET` | Developers → Webhooks → the endpoint below → Signing secret |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | The Connect endpoint below → Signing secret |
| `ADMIN_EMAILS` | Your own sign-in email, so your account has no AI allowance and sees app-wide figures |

## 2. Webhook endpoints

Both point at `https://<your API host>/api/stripe/webhook`.

- **Your account** events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `payment_intent.processing`, `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `payment_intent.canceled`.
- **Connected accounts** (a second endpoint, "Listen to events on Connected accounts"): `account.updated`, plus the
  same `checkout.session.*` and `payment_intent.*` events.

After each step below, Developers → Webhooks → the endpoint should show the event delivered with a **200**.

## 3. Subscriptions

Use a new test account (sign up with a second email), not your own.

- [ ] **Trial:** a new sign-up shows 14 days left on Settings → Plan & Billing and can add properties.
- [ ] **Checkout:** choose Pro, pay with `4242 4242 4242 4242` (any future date, any CVC). Back in Sollux the plan
      shows **Pro, active**.
- [ ] **Upgrade / downgrade:** Manage billing → change to Portfolio. Sollux shows Portfolio within a minute.
- [ ] **Failed renewal:** in Stripe, open the subscription → update the payment method to `4000 0000 0000 0341`
      → advance the test clock past the renewal (or "Create invoice" → pay). The account shows **past due** and still
      works while Stripe retries.
- [ ] **Cancellation:** Manage billing → cancel immediately. The account becomes read-only: viewing works,
      adding a property says the plan has ended.
- [ ] **Plan limit:** on Starter, a 4th property is refused with a message about the plan.

## 4. Rent collection (Stripe Connect)

- [ ] **Owner onboarding:** Settings → Rent collection → Set up payouts → finish Stripe's Express form with test
      data (routing `110000000`, account `000123456789`). Sollux shows payments and payouts enabled.
- [ ] **Card rent:** invite a test tenant, sign in to the portal, pay by card `4242…`. The tenant pays rent plus the
      card fee; the rent payment shows **received** on the lease; the owner's Express dashboard shows the full rent.
- [ ] **Bank rent:** pay by bank with Stripe's test bank. The tenant pays rent only; the payment shows **pending**,
      then **received** once it settles. The owner receives rent less 0.8% (at most $5).
- [ ] **Failed bank payment:** use the test account that fails (`000111111116`). The payment shows **failed** and the
      balance is owed again.
- [ ] **Autopay:** turn on autopay in the portal; on the rent's due day (or by running the autopay job) the month is
      charged once, never twice.

## 5. AI cost per customer

- [ ] Settings → AI usage on the test account shows its own spend against its plan's allowance ($8 on the trial).
- [ ] On your own account it shows the whole app's spend against `AI_MONTHLY_BUDGET`. Raise that budget as
      customers join: each plan's allowance (Starter $3, Pro $8, Portfolio $15) is the most one account can use.
