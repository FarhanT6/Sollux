# Owner checklist

Things only the owner can do, noted on Oct 15, 2026. Tick them off as you go.

## Email and text alerts (shut-off and cancellation notices)
- [ ] **SendGrid (email):** on the onboarding screen, choose *Skip to dashboard*.
  - **Settings → Sender Authentication → Verify a Single Sender**, using farhantalukder6@gmail.com, then click the link in the email SendGrid sends.
  - **Settings → API Keys → Create API Key**, with Restricted Access and *Mail Send = Full Access*. Copy the `SG.` key; it's only shown once.
- [ ] **Twilio (texts):** copy the Account SID and Auth Token.
  - **Phone Numbers → Buy a number** with SMS.
  - Trial accounts can only text verified numbers. To text anyone else, upgrade and complete A2P 10DLC (Sole Proprietor) registration.
- [ ] **Render → Environment Groups → `sollux-env`:** add `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME` (= Sollux), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_PHONE_NUMBER` (written like `+17605550123`). Save; Render redeploys.
- [ ] **Sollux → Settings → Profile → Mobile for alerts:** enter your number and save. Fahim can do the same under his own login.
- [ ] **Settings → Notifications:** check that "Shut-off & cancellation notices" is on (it is by default).
- [ ] If the first alert email lands in Spam, mark it *Not spam*. If that keeps happening, get a domain for Sollux.

## Import page
- [ ] **Bills filed twice:** review the list, then *Merge all*.
- [ ] **Backfill:** press *Sync now* until both inboxes say "read Oct …" instead of "backfilling to …".
- [ ] **Review list:**
  - Dignity Memorial **…7055** card → switch it to the 7055 account.
  - Home Depot, Lowe's and PayPal Credit → *Credit card statement*.
  - Mauzy "Jetter for sewer line" ($961) → *One-time invoice*, then pick the property and *Repairs & maintenance*.
  - Mauzy Invoice #345681421 ($0.00) → remove.
  - The two SDG&E notices (…9589, …1592) → pick the account.
  - SDG&E …9073 (1015 S Coast Hwy) → create the account if that meter is yours.
  - Anthropic, Apple and other receipts → *Receipt / subscription*, or remove.
  - Remove the cards that aren't bills, then *Mark done*.

## Accounts
- [ ] **Home Depot card:** click *Read statement* again (the "Streaming is required" error is fixed).
- [ ] **City of Brawley (432 W D St):** delete the "billed Sep 25, billing period —" row, or merge it from the Import page.
- [ ] **476 H St (Brawley, account 01-1963-03):** check that the September bill ($934.80) came in.
- [ ] **Westlake Portfolio Management:** re-import the May–Dec 2025 PDFs; the $5.00 rows were a misread. Check the Mar 2025 $0.00 row.
- [ ] **Bamboo:** the insured property is 4349 Vista Verde Way, but the policy is filed under 432 W D St (UWM escrow). Confirm which is right.
