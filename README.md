# Mystry Mart website

One page (`index.html`) holds every section of the site: Shop, Locations, Apply, Press, About, FAQ and Contact.
Two small server functions handle Stripe checkout.

## Put it online (Netlify, free tier works)

Checkout needs Netlify to install the Stripe code for the server functions, so use the GitHub route, not drag-and-drop.

1. Create free accounts at github.com and netlify.com.
2. On GitHub, create a new repository (private is fine) and upload everything in this folder: **Add file > Upload files**, then drag the files and the `netlify` folder in.
3. In Netlify: **Add new site > Import an existing project > GitHub**, and pick that repository. Leave the build settings as they are and deploy.
4. In **Site configuration > Environment variables**, add:
   - `STRIPE_SECRET_KEY` = your Stripe secret key (starts with `sk_test_` while testing, `sk_live_` when you go live)
   - `ARTIST_PAYOUT_BASE` = total you've paid artists from the machines, in dollars (e.g. `213487`). The About page counter starts here and adds 50% of every online sale automatically.
5. Redeploy (**Deploys > Trigger deploy**), then test everything on your free `something.netlify.app` address.
6. When you're happy, connect mystrymart.com under **Domain management** and follow the DNS records Netlify shows you.

To update the site later, upload the new files to the same GitHub repository and Netlify redeploys on its own.

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
