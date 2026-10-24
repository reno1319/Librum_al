import { SELLER, SELLER_PENDING_TEXT, isSellerRegistered, type SellerDetails } from "@/lib/seller";

// POLICY PAGES: the seller block shared by Privacy, Terms and the Refund
// Policy, so the company details are typed in one place only.
export function SellerDetailsBlock({ seller = SELLER }: { seller?: SellerDetails }) {
  if (!isSellerRegistered(seller)) {
    return <p className="mt-2">{SELLER_PENDING_TEXT}</p>;
  }
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt className="text-muted">Company</dt>
      <dd>{seller.name}</dd>
      <dt className="text-muted">NIPT</dt>
      <dd>{seller.nipt}</dd>
      <dt className="text-muted">Address</dt>
      <dd>{seller.address}</dd>
      <dt className="text-muted">Phone</dt>
      <dd>{seller.phone}</dd>
    </dl>
  );
}
