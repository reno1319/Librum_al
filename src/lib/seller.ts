// POLICY PAGES (Renato, 10-24, 4. a): the company that sells on Librum.
// Law 50/2025 (CEFTA e-commerce decision, Annex II(A)) asks for the
// seller's name, address and phone, and Law 124/2024 for the data
// controller's identity. The SHPK isn't registered yet, so every field
// is empty and the pages show a "will be added" sentence instead of
// blank brackets. Fill all four at once when the NIPT arrives.
export type SellerDetails = {
  name: string;
  nipt: string;
  address: string;
  phone: string;
};

export const SELLER: SellerDetails = {
  name: "",
  nipt: "",
  address: "",
  phone: "",
};

export const SELLER_PENDING_TEXT =
  "Librum's company details (registered name, NIPT, address and phone number) will be added here once the company's registration is complete.";

// All four or nothing: a half-filled block would look like an error to
// a reader and to POK's review.
export function isSellerRegistered(seller: SellerDetails = SELLER): boolean {
  return [seller.name, seller.nipt, seller.address, seller.phone].every((value) => value.trim() !== "");
}
