import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Book uploads (cover + EPUB) can be up to ~55MB combined —
      // see MAX_COVER_BYTES / MAX_MANUSCRIPT_BYTES in
      // src/app/dashboard/books/actions.ts.
      bodySizeLimit: "60mb",
    },
  },
};

export default nextConfig;
