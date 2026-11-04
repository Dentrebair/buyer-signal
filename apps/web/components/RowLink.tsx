"use client";
import Link, { useLinkStatus } from "next/link";

// A database round trip takes ~1 s, so the clicked row shows it is loading straight away.
function Pending() {
  const { pending } = useLinkStatus();
  return <span aria-hidden className={`row-pending${pending ? " is-pending" : ""}`} />;
}

export function RowLink({ href, current, children }: { href: string; current: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} className="row" aria-current={current ? "true" : undefined} scroll={false}>
      {children}
      <Pending />
    </Link>
  );
}
