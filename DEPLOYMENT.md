# Vercel + Firebase setup

The dashboard is served from `public/`. The API runs as a Vercel Function in `api/[...path].js`. Firebase Authentication handles sign-in and Cloud Firestore stores application data in project `gobi-web-6`. The Firebase browser config is public; keep service-account credentials in Vercel environment variables.

## 1. Prepare Firebase

1. In Firebase project `gobi-web-6`, enable **Authentication → Sign-in method → Email/Password**.
2. Create the Cloud Firestore database.
3. Add the deployed Vercel domain (for example, `your-site.vercel.app`) under **Authentication → Settings → Authorized domains**.
4. In **Project settings → Service accounts**, generate a private key and keep the downloaded JSON private.
5. Deploy the included deny-all Firestore rules. The server API accesses Firestore using the service account:

   ```sh
   npx firebase-tools login
   npx firebase-tools use gobi-web-6
   npx firebase-tools deploy --only firestore:rules
   ```

The browser Firebase config is in `public/firebase-config.js`. Its API key is public by design. Add the Vercel domain to Firebase Authentication's authorized domains.

## 2. Deploy to Vercel

1. Push this project to a Git repository and import it into Vercel, or deploy this folder with the Vercel CLI.
2. Keep the project root as the repository root. Vercel serves static files from `public/`, routes `/api/*` to the function in `api/[...path].js`, and applies `vercel.json`.
3. In Vercel **Project → Settings → Environment Variables**, add:

   | Variable | Required | Value |
   | --- | --- | --- |
   | `FIREBASE_SERVICE_ACCOUNT` | Yes | Entire Firebase service-account JSON. Keep private. |
   | `RESELLER_API_KEY` | If reseller API is used | Reseller provider API key. |
   | `RESELLER_MASTER_KEY` | If required by provider | Reseller provider master key. |
   | `FAMGATEWAY_API_KEY` | If UPI deposits are used | FamGateway API key. |

   Paste service-account JSON as a single-line JSON value. The function also accepts base64-encoded JSON. The service account needs Firebase Authentication and Firestore access.
4. Redeploy after adding or changing environment variables.

## 3. First administrator

Create an account on the deployed website. Then, through a trusted administrative process, update `users/<Firebase Auth UID>` in Firestore to include `role: "ADMIN"`. The API does not allow a new user to grant themselves admin access.

## Local development

Install dependencies with `npm install`, set the same environment variables in a local `.env` file, and run `npx vercel dev`. `.env` is ignored by Git. Never put service-account JSON in `public/` or commit it.
