/**
 * `NEXT_PUBLIC_API_URL` is inlined at build time, so a deployment that forgets
 * it does not fail — it ships a site that renders perfectly and cannot log in,
 * because every request goes to localhost. That is a confusing hour for
 * whoever deploys it, and setting the variable afterwards changes nothing
 * without a rebuild.
 *
 * On a hosted build (Vercel sets VERCEL=1; CI sets CI) the default is never
 * what anyone wants, so say so while there is still a build log to read.
 * Locally the default is exactly right and nothing is in the way.
 */
const hosted = process.env.VERCEL === '1' || process.env.CI === 'true';
if (hosted && !process.env.NEXT_PUBLIC_API_URL) {
  throw new Error(
    'NEXT_PUBLIC_API_URL is not set.\n' +
      '  It is baked into the bundle at build time, so without it this deployment\n' +
      '  would render but never reach an API. Set it to the Goal 27 API base URL\n' +
      '  (for example https://goal27-api.onrender.com) and redeploy.',
  );
}

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
};
