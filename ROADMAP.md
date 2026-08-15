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

- [ ] Homepage redesign in the new style (hero section, curated layout)
- [x] Search bar
- [x] Genres/categories (add to book upload form + storefront filtering)
- [ ] Book detail page redesign
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

- [ ] Deploy to Vercel
- [ ] Custom domain
- [ ] Switch the Stripe webhook from the local CLI listener to a real
      deployed endpoint

## Phase 2: Platform Depth

Everything above got Librum to "fully working MVP." This section is about
depth — features real self-publishing and creator-commerce platforms
lean on that we don't have yet. Each item names what it's modeled after.

### Storefront depth (Amazon/KDP storefront, Gumroad discover)

- [ ] Homepage redesign: a featured-book hero section, plus curated
      rows ("New releases", "Bestsellers") instead of one flat grid —
      carries over the unfinished item from the original roadmap
- [ ] Book detail page redesign: richer layout, a "More by this author"
      row and a "You might also like" row (same genre) — carries over
      the unfinished item from the original roadmap
- [ ] Bestseller/trending sorting on the homepage, using existing sales
      data (no new tracking needed)

### Commerce (Gumroad, Payhip, KDP countdown deals)

- [ ] Discount codes: authors create a promo code (% or $ off);
      applied at Stripe Checkout
- [ ] Bundles: an author combines their own books into one discounted
      package, purchased as a single checkout that unlocks every book
      in it (meaningfully more complex than the other items here — a
      single Stripe session has to expand into multiple purchase rows)

### Catalog depth (Amazon KDP, Lulu)

- [ ] Series: group an author's books into a series with a reading
      order, shown on each book's page
- [ ] Co-authors & contributors: credit illustrators, translators,
      narrators, or co-authors on a book, not just a single author
- [ ] Keywords/tags: additional searchable metadata beyond genre

### Engagement (Gumroad-style following)

- [ ] Follow an author: readers opt in to an email when someone they
      follow publishes a new book (reuses the existing email
      infrastructure from Notifications)
- [ ] Basic view-count analytics on the author sales dashboard (how
      many people looked at a book page, not just who bought it)
