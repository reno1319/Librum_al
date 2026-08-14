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
- [ ] Search bar
- [ ] Genres/categories (add to book upload form + storefront filtering)
- [ ] Book detail page redesign
- [ ] "Look inside" sample preview (an excerpt readers can view before
      buying)
- [ ] Author public profile pages (bio, photo, their books)
- [ ] Reader reviews & star ratings

## Author Tools

- [ ] Edit an existing book (title/description/price/cover/file) —
      currently publish/unpublish/delete only, no edit
- [ ] Author sales dashboard (revenue over time, units sold, per-book
      breakdown)

## Reader Tools

- [ ] Order history / purchase receipts
- [ ] Wishlist / save for later

## Trust, Legal & Info Pages

- [ ] About page
- [ ] Help / FAQ page
- [ ] Terms of Service (placeholder — not real legal advice)
- [ ] Privacy Policy (placeholder — not real legal advice)
- [ ] "How self-publishing works" guide for authors
- [ ] Contact / support page

## Trust & Safety

- [ ] Watermark downloads with the buyer's email (lightweight
      anti-piracy — full DRM is out of scope)
- [ ] Refunds: a Stripe refund should revoke the reader's access
- [ ] "Report this book" flag for readers

## Notifications

- [ ] Purchase receipt email to readers
- [ ] "You made a sale" email to authors

## Account & Settings

- [ ] Edit profile (display name, avatar)
- [ ] Forgot-password flow
- [ ] Delete account

## Going Live

- [ ] Deploy to Vercel
- [ ] Custom domain
- [ ] Switch the Stripe webhook from the local CLI listener to a real
      deployed endpoint
