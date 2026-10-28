import type { Metadata } from "next";
import { SystemStatus } from "@/components/status/SystemStatus";

export const metadata: Metadata = { title: "Stan systemu" };

export default function StatusPage() {
  return (
    <div className="page">
      <SystemStatus />
    </div>
  );
}
