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
  "Të dhënat e kompanisë Librum (emri i regjistruar, NIPT-i, adresa dhe numri i telefonit) do të shtohen këtu sapo të përfundojë regjistrimi i kompanisë.";

// All four or nothing: a half-filled block would look like an error to
// a reader and to POK's review.
export function isSellerRegistered(seller: SellerDetails = SELLER): boolean {
  return [seller.name, seller.nipt, seller.address, seller.phone].every((value) => value.trim() !== "");
}
