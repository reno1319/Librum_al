import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Book uploads (cover + EPUB) can be up to ~55MB combined —
      // see MAX_COVER_BYTES / MAX_MANUSCRIPT_BYTES in
      // src/app/dashboard/books/actions.ts.
      bodySizeLimit: "60mb",
    },
    // src/proxy.ts runs on nearly every request (session refresh), and
    // Next.js buffers the full request body for it up to this limit
    // (default 10MB) before the Server Action ever sees it — anything
    // over gets silently truncated, corrupting the multipart upload.
    proxyClientMaxBodySize: "60mb",
  },
};

export default nextConfig;
