import type { MetadataRoute } from "next";

// K9 (Renato 11-14, 2a): "install as app" = a home-screen icon only.
// Librum opens full-screen from the homepage and still needs internet;
// there is no service worker and nothing of a book is stored offline
// (that would work against the download gate and the watermark).
// Served at /manifest.webmanifest, which the proxy matcher skips so the
// lock page never answers for it (browsers fetch it without cookies).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Librum",
    short_name: "Librum",
    description: "Libra elektronikë shqip: lexoni, blini dhe botoni.",
    lang: "sq",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f7f3ea",
    theme_color: "#1e3a32",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
