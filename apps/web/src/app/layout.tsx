import "./globals.css";
import type { ReactNode } from "react";
import { PatientSidebar } from "@/components/patient-sidebar";

export const metadata = {
  title: "Clinical Trial Matching",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen flex">
        <PatientSidebar />
        <main className="flex-1 p-6">{children}</main>
      </body>
    </html>
  );
}
