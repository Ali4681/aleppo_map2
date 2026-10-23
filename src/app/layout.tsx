import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import './interface.css';
export const metadata: Metadata = { title: 'حلب القديمة — 3D', description: 'استكشف حلب القديمة ثلاثية الأبعاد' };
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      {/* Browser extensions can inject body attributes before hydration. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
