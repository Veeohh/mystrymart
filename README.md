# Mystry Mart website

One page (`index.html`) holds every section of the site: Shop, Locations, Apply, Press, About, FAQ and Contact.
Two small server functions handle Stripe checkout.

## Put it online (Netlify, free tier works)

1. Create a free account at netlify.com.
2. Drag this whole folder onto the Netlify dashboard (or connect it from GitHub).
3. In **Site configuration > Environment variables**, add:
   - `STRIPE_SECRET_KEY` = your Stripe secret key (starts with `sk_test_` while testing, `sk_live_` when you go live)
   - `ARTIST_PAYOUT_BASE` = total you've paid artists from the machines, in dollars (e.g. `213487`). The About page counter starts here and adds 50% of every online sale automatically. Update it whenever you pay out.
4. Redeploy. Checkout, the artist application and the contact form now work.
5. Point mystrymart.com at the site under **Domain management** when you're ready to switch from Squarespace.

## Where things land
- **Payments:** your Stripe dashboard. Each payment's metadata shows the bag code, artist, buyer name and shipping address.
- **Contact messages and newsletter signups:** Netlify dashboard > Forms. Turn on email notifications there, and export signups as a CSV (or connect Mailchimp, Klaviyo or Kit with Zapier) to send newsletters.
- **Artist applications:** your JotForm account.

## Testing payments
Use Stripe's test card `4242 4242 4242 4242`, any future date, any CVC.

## Going live
1. Swap `STRIPE_SECRET_KEY` in Netlify for your live secret key.
2. In `index.html`, search for `STRIPE_PK` and paste your live publishable key (`pk_live_...`).

## Editing content (all in index.html)
- Artists in each slot: search for `const ARTISTS`
- Locations: search for `const LOCATIONS`
- Press: search for `const PRESS`
- Miami application link: search for `const JOTFORM_URL`
- Price: search for `const PRICE` (also change `PRICE_CENTS` in `netlify/functions/checkout.js`)

Never put the secret key in `index.html`. Anyone can read that file.
