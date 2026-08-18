import Link from "next/link";

export default function CartPage() {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-sm flex-1 flex-col justify-center px-4 text-center">
      <h1 className="font-serif text-3xl font-semibold">
        Your cart is empty
      </h1>
      <p className="mt-3 text-sm text-muted">
        Did you leave something in your cart? Log in now to see your saved
        cart.
      </p>
      <Link
        href="/login"
        className="mt-6 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
      >
        Log in
      </Link>
    </main>
  );
}
