# Librum Roadmap

Everything left to make this feel like a real self-publishing platform, in
the spirit of Amazon KDP / Lulu, adapted for ebooks only. Organized by
area — not a strict order. We build these one at a time, whatever order
you want to go in; check items off as we finish them.

**Name:** Librum (renamed from the placeholder "Dante").
**Design direction:** warm & editorial — a literary bookstore feel (warm
neutral palette, serif headings for titles) rather than a generic SaaS
dashboard. Established in Foundation, then reused everywhere else.

## Foundation

- [x] Rebrand "Dante" → "Librum" across the UI, page titles, and docs
- [x] Warm/editorial design system: color palette, serif heading font,
      consistent buttons/cards/badges other pages build on
- [x] Mobile-responsive pass across existing pages

## Discovery & Storefront

- [x] Homepage redesign in the new style (hero section, curated layout)
      — see "Phase 2: Storefront depth" below
- [x] Search bar
- [x] Genres/categories (add to book upload form + storefront filtering)
- [x] Book detail page redesign — see "Phase 2: Storefront depth" below
- [x] "Look inside" sample preview (an excerpt readers can view before
      buying) — the author writes/pastes it in when uploading or editing
      a book, rather than auto-extracting from the EPUB, which is too
      unreliable given how much real-world EPUB structure varies
- [x] Author public profile pages (bio, photo, their books)
- [x] Reader reviews & star ratings

## Author Tools

- [x] Edit an existing book (title/description/price/cover/file) —
      currently publish/unpublish/delete only, no edit
- [x] Author sales dashboard (revenue over time, units sold, per-book
      breakdown)

## Reader Tools

- [x] Order history / purchase receipts — merged into My Library rather
      than a separate page, since it's the same underlying data
- [x] Wishlist / save for later

## Trust, Legal & Info Pages

- [x] About page
- [x] Help / FAQ page
- [x] Terms of Service (placeholder — not real legal advice)
- [x] Privacy Policy (placeholder — not real legal advice)
- [x] "How self-publishing works" guide for authors
- [x] Contact / support page

## Trust & Safety

- [x] Watermark downloads with the buyer's email (lightweight
      anti-piracy — full DRM is out of scope)
- [x] Refunds: a Stripe refund should revoke the reader's access —
      issuing the refund itself is still manual (via Stripe's dashboard),
      but once issued, the webhook automatically revokes access
- [x] "Report this book" flag for readers — stored in the database;
      there's no in-app moderation UI yet, so review reports directly in
      the Supabase Table Editor for now

## Notifications

- [x] Purchase receipt email to readers
- [x] "You made a sale" email to authors

## Account & Settings

- [x] Edit profile (display name, avatar) — bio included too, done as
      part of author profile pages
- [x] Forgot-password flow
- [x] Delete account

## Going Live

- [x] Deploy to Vercel — live at https://librumal.vercel.app (Stripe
      still in test mode, so purchases use fake test cards, no real
      money moves)
- [ ] Custom domain
- [x] Switch the Stripe webhook from the local CLI listener to a real
      deployed endpoint

## Phase 2: Platform Depth

Everything above got Librum to "fully working MVP." This section is about
depth — features real self-publishing and creator-commerce platforms
lean on that we don't have yet. Each item names what it's modeled after.

### Storefront depth (Amazon/KDP storefront, Gumroad discover)

- [x] Homepage redesign: a featured-book hero section, plus curated
      rows ("New releases", "Bestsellers") instead of one flat grid —
      carries over the unfinished item from the original roadmap.
      Search/filter results still show as the flat grid, unchanged
- [x] Book detail page redesign: richer layout, a "More by this author"
      row and a "You might also like" row (same genre, different
      author) — carries over the unfinished item from the original
      roadmap. Extracted BookShelf into a shared component since the
      homepage redesign already needed the same horizontal-shelf UI
- [x] Bestseller/trending sorting on the homepage, using existing sales
      data (no new tracking needed) — done together with the redesign
      above, since the "Bestsellers" shelf needed exactly this
- [x] Homepage split into an author pitch and a reader marketplace —
      originally two tracks on one page (draft2digital/IngramSpark/Kobo
      Writing Life-style), later split into two separate pages, Home
      and Bookstore, in Phase 3 below — see README for details
- [x] "Everything you need to sell your book" tools showcase on the
      homepage (sales dashboard, discount codes, series, watermarking)
- [x] Non-blocking pre-publish checklist for draft books (description,
      keywords, preview excerpt, price) — dashboard list + edit page
- [x] Homepage visual design pass: real book-cover imagery (hero
      collage, stacked-shelf backdrop), hand-drawn inline SVG icons,
      tighter spacing rhythm, and a multi-column footer

### Commerce (Gumroad, Payhip, KDP countdown deals)

- [x] Discount codes: authors create a promo code (% or $ off);
      applied at Stripe Checkout
- [x] Bundles: an author combines their own books into one discounted
      package, purchased as a single checkout that unlocks every book
      in it (meaningfully more complex than the other items here — a
      single Stripe session has to expand into multiple purchase rows)

### Catalog depth (Amazon KDP, Lulu)

- [x] Series: group an author's books into a series with a reading
      order, shown on each book's page
- [x] Co-authors & contributors: credit illustrators, translators,
      narrators, or co-authors on a book, not just a single author
- [x] Keywords/tags: additional searchable metadata beyond genre

### Engagement (Gumroad-style following)

- [x] Follow an author: readers opt in to an email when someone they
      follow publishes a new book (reuses the existing email
      infrastructure from Notifications)
- [x] Basic view-count analytics on the author sales dashboard (how
      many people looked at a book page, not just who bought it)

## Phase 3: Librum.al roadmap alignment

Reviewed against two planning documents modeled on Lulu.com (sitemap +
screenshots). Decisions made on what to adopt now vs. defer:

- [x] Color palette switched to dark blue + orange + light gray (was
      warm maroon/cream/forest-green)
- [x] Header nav restructured to mirror Lulu's Produktet/Honoraret/
      Krijo/Libraria/Llogaria ime grouping — added "Browse" (jumps to
      the reader marketplace) and "Create" (authors' quick link to
      publish a new book) as first-class nav items, alongside the
      existing Pricing/Dashboard/Library/Wishlist/Following/Account
- [x] "Boto me L&K" footer link to the author's separate imprint
      (lamajkalemi.al)
- [x] Optional ISBN field on books (metadata only — Librum doesn't issue
      or register ISBNs)
- [x] Browse/search: sort (newest, bestselling, price) and a min/max
      price filter, alongside the existing search + genre filter
- [x] "Why Librum?" 3-benefit strip on the homepage (speed, earnings
      control, reach) — honest copy, no distribution claims we don't
      actually offer
- [x] Add-book form converted into a 4-step wizard (manuscript & cover,
      details, price, review), matching the doc's guided "Krijo" flow
- [x] Homepage split: `/` is exclusively the author pitch for everyone
      (no more logged-in-author/filtered skip logic), and the reader
      storefront moved to its own **Bookstore** page (`/bookstore`),
      matching the doc's separate "Libraria" page rather than one page
      serving both audiences
- [x] Home hero redesigned to match the doc's Lulu-style layout:
      full-bleed dark-blue band, "Write. Publish. Profit." headline, two
      CTAs (Publish your book / Create an account, no emoji), and a
      horizontally-scrolling strip of real covers below it
- [x] Header nav: added Products and Program as honest "coming soon"
      placeholder pages (no dead-end links) for the doc's Produktet and
      Programi i Bashkëpunimit items we haven't built yet
- [x] Footer: added Instagram/Facebook icon links (placeholder `#`
      hrefs — swap in the real profile URLs)
- [x] Hero simplified to a single "Publish your book" CTA (dropped the
      second "Create an account" button), and the primary blue
      brightened to match Lulu's actual brand color (was dark navy)
- [x] Header restructured Lulu-style: fixed left nav group (Products,
      Bookstore, Pricing, Program, How it works, now always visible
      regardless of login state) plus a cart icon and a single account
      icon on the right (replacing separate Log in / Sign up links) —
      Librum has no real cart, so /cart is an honest static "empty
      cart, log in to see your saved cart" page
- [ ] Not doing yet, by explicit choice: Albanian translation (English
      first, translate once the feature set settles), physical
      print-on-demand (ebook-only for now), additional ebook export
      formats beyond EPUB (PDF/MOBI/AZW3/etc.), an affiliate/referral
      program, a "Komuniteti" resources section, a %-of-book free
      preview (keeping the existing free-text excerpt), and a
      balance/withdraw-funds payout model (keeping instant per-sale
      Stripe transfers)
