import { cookies } from "next/headers";
import Dashboard from "@/components/dashboard";

export default function Home() {
  // Middleware has already verified tyck_sig for tyck_role; the cookie
  // value is trusted here. Default to dip only as a display fallback;
  // it does not grant anything (gates are enforced server-side).
  const role = cookies().get("tyck_role")?.value === "johnny" ? "johnny" : "dip";
  return <Dashboard role={role} />;
}
